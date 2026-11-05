import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Box, Eye, EyeOff, Maximize2, Minimize2, Minus, Move, Pause, Play, Plus, RotateCcw, RotateCw,
  Save, Trash2, X,
} from 'lucide-react';
import {
  ApiError, SITE_AREA_KINDS, SITE_PROGRESS_KINDS, SITE_STRUCTURE_KINDS, SiteTwin, SiteTwinActivity, SiteTwinStatus,
  SiteTwinZone, SiteZoneKind, apiArrangeSiteTwinAround, apiGetSiteTwin, apiMyPermissions, apiSaveSiteTwinLayout,
} from '../../lib/api';
import type { DragTarget, SceneFocus, SceneMachine } from '../visual/SiteTwinScene';
import { appLocale } from '../../lib/dateLocale';

// Lazy, as on the machine page: three.js is fetched only when the twin is on screen.
const SiteTwinScene = lazy(() => import('../visual/SiteTwinScene'));

// Kept here as well as in the scene so the legend renders before three.js has loaded.
const STATUS_COLOUR: Record<SiteTwinStatus, string> = {
  alert: '#e11d48', live: '#16a34a', no_data: '#f59e0b', blocked: '#7c3aed', not_configured: '#94a3b8',
};
const ZONE_COLOUR: Record<SiteZoneKind, string> = {
  work_area: '#a7c4a0', material_yard: '#d9c48f', parking: '#b9bfcc', restricted: '#d9a3a3',
  head_office: '#cdd5df', site_office: '#cdd5df', batching_plant: '#d4d0c8', maintenance_workshop: '#d4d0c8',
  gate: '#cdd5df', road: '#a8a29e', building: '#d4d0c8', substation: '#cdd5df', quay: '#c9d6df',
  container_yard: '#d4d0c8', quay_crane_berth: '#c9d6df',
  generator_room: '#d4d0c8', compressor_house: '#d4d0c8', quarry: '#c9a57e',
};
const ZONE_NAME: Record<SiteZoneKind, string> = {
  work_area: 'Work area', material_yard: 'Material yard', parking: 'Parking', restricted: 'Restricted',
  head_office: 'Head office', site_office: 'Site office', batching_plant: 'Batching plant',
  maintenance_workshop: 'Maintenance workshop', gate: 'Gate', road: 'Road', building: 'Building',
  substation: 'Substation', quay: 'Quay / jetty', container_yard: 'Container yard', quay_crane_berth: 'Quay crane berth',
  generator_room: 'Generator room', compressor_house: 'Compressor house', quarry: 'Quarry',
};
const ACTIVITY_NAME: Record<SiteTwinActivity, string> = {
  productive: 'Working', idle: 'Idling', 'running-unclassified': 'Engine on', off: 'Engine off', unknown: 'No activity data',
};
const ACTIVITY_COLOUR: Record<SiteTwinActivity, string> = {
  productive: '#16a34a', idle: '#f59e0b', 'running-unclassified': '#0ea5e9', off: '#64748b', unknown: '#94a3b8',
};
/** The same five states as text: a colour class with its dark pair, never a hex on words. */
const STATUS_TEXT: Record<SiteTwinStatus, string> = {
  alert: 'text-rose-600 dark:text-rose-400', live: 'text-emerald-600 dark:text-emerald-400',
  no_data: 'text-amber-600 dark:text-amber-400', blocked: 'text-violet-600 dark:text-violet-400',
  not_configured: 'text-slate-500 dark:text-slate-400',
};
const STATUS_ORDER: SiteTwinStatus[] = ['live', 'alert', 'no_data', 'blocked', 'not_configured'];
// The fleet reports about every 20 s; the twin follows it.
const REFRESH_MS = 20_000;
const LANE_SPACING = 9;

type Pos = { x: number; z: number; headingDeg: number; route: string[] };
interface Draft { extent: SiteTwin['extent']; zones: SiteTwinZone[]; positions: Map<string, Pos> }

const mkey = (m: { sourceSystem: string; externalId: string }) => `${m.sourceSystem}/${m.externalId}`;
const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** A zone as the API takes it: the read-only report fields dropped, which the server refuses. */
const zoneBody = (z: SiteTwinZone) => ({
  key: z.key, label: z.label, kind: z.kind, x: z.x, z: z.z, widthM: z.widthM, depthM: z.depthM,
  floors: z.kind === 'building' ? z.floors ?? null : null,
  progressPct: SITE_PROGRESS_KINDS.includes(z.kind) ? z.progressPct ?? null : null,
});

/**
 * The site's digital twin: every machine on the site, where it stands, in its class's
 * 3-D model, coloured by what the platform actually knows about it.
 *
 * Status comes from the API and is never derived here — the same readiness and alert
 * count as the site page's machine list. Someone with `equipment.write` can lay the
 * site out: drag machines, draw zones, set its size. A save names the version it was
 * drawn on, so two people editing at once are told rather than overwritten.
 */
export const SiteTwinCard: React.FC<{ plantId: string }> = ({ plantId }) => {
  const { t } = useTranslation('equipment');
  const navigate = useNavigate();
  const frame = useRef<HTMLDivElement>(null);
  const [twin, setTwin] = useState<SiteTwin | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [canEdit, setCanEdit] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  // Labels on by default only where they fit: sixty names over sixty machines is a wall
  // of text. Hovering or selecting a machine always shows its own.
  const [showLabels, setShowLabels] = useState<boolean | null>(null);
  const [autoRotate, setAutoRotate] = useState(false);
  const [focusIndex, setFocusIndex] = useState<number>(-1);
  const [zoom, setZoom] = useState<{ n: number; dir: -1 | 0 | 1 }>({ n: 0, dir: 0 });
  const [fullscreen, setFullscreen] = useState(false);

  const statusLabel = (s: SiteTwinStatus) => t(`siteTwin.status.${s}`, {
    defaultValue: { alert: 'Alert', live: 'Live', no_data: 'No recent data', blocked: 'Sensor missing', not_configured: 'Not set up' }[s],
  });
  const zoneLabel = (k: SiteZoneKind) => t(`siteTwin.zone.${k}`, { defaultValue: ZONE_NAME[k] });
  const activityLabel = (a: SiteTwinActivity) => t(`siteTwin.activity.${a}`, { defaultValue: ACTIVITY_NAME[a] });

  const load = useCallback(() => apiGetSiteTwin(plantId)
    .then((r) => { setTwin(r); setError(undefined); return r; })
    .catch((err) => { setError(err instanceof ApiError ? err.message : t('siteTwin.loadFailed', { defaultValue: 'The digital twin could not be loaded.' })); return null; }),
  [plantId, t]);

  useEffect(() => {
    void load();
    apiMyPermissions().then((p) => setCanEdit(!!p.capabilities['equipment.write'])).catch(() => setCanEdit(false));
  }, [load]);

  // Status is live; the layout is not. Refresh only while nobody is mid-edit.
  useEffect(() => {
    if (draft) return;
    const id = window.setInterval(() => { void load(); }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [draft, load]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frame.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const extent = draft?.extent ?? twin?.extent ?? { widthM: 200, depthM: 120 };
  const zones = draft?.zones ?? twin?.zones ?? [];

  const machines: SceneMachine[] = useMemo(() => {
    if (!twin) return [];
    const placedAt = (m: SiteTwin['machines'][number]): Pos | null =>
      draft ? draft.positions.get(mkey(m)) ?? null : m.placement;
    const unplaced = twin.machines.filter((m) => !placedAt(m));
    const byKey = new Map(zones.map((z) => [z.key, z]));
    return twin.machines.map((m) => {
      const p = placedAt(m);
      const lane = unplaced.indexOf(m);
      const x = p ? p.x : (lane - (unplaced.length - 1) / 2) * LANE_SPACING;
      const z = p ? p.z : extent.depthM / 2 + 14;
      const stops = (p?.route ?? []).map((k) => byKey.get(k)).filter((zn): zn is SiteTwinZone => !!zn);
      return {
        key: mkey(m), name: m.name ?? m.externalId, classSlug: m.classSlug, status: m.status,
        placed: !!p, x, z, headingDeg: p?.headingDeg ?? 0,
        activity: m.activity,
        path: stops.length ? [[x, z] as [number, number], ...stops.map((zn) => [zn.x, zn.z] as [number, number])] : [],
        engagedLabel: m.engagedAt ? byKey.get(m.engagedAt)?.label ?? null : null,
        breakdown: m.breakdown,
      };
    });
  }, [twin, draft, extent.depthM, zones]);

  // Demo only: a site with no haul fleet of its own gets three simulated tippers running
  // between its fronts, so the picture shows work being carried. Never on a real
  // account, never saved, and labelled as what they are.
  const shown: SceneMachine[] = useMemo(() => {
    if (!twin?.simulated || draft) return machines;
    if (machines.some((m) => /tipper|dumper|truck|transport|haul|transit/i.test(m.classSlug ?? ''))) return machines;
    const pick = (...keys: string[]) => keys.map((k) => zones.find((z) => z.key === k)).find(Boolean);
    const from = pick('quarry', 'excavation', 'road-b');
    const to = pick('batching-plant', 'building', 'road-c', 'access-road');
    const gate = pick('gate');
    if (!from || !to || !gate) return machines;
    const path: [number, number][] = [[gate.x, gate.z], [from.x, from.z], [to.x, to.z]];
    return [...machines, ...[0, 1, 2].map((i) => ({
      key: `demo-tipper-${i}`, name: t('siteTwin.demoTipper', { defaultValue: 'Demo tipper {{n}} (simulated)', n: i + 1 }),
      classSlug: 'rock-tipper-truck', status: 'live' as SiteTwinStatus, placed: true,
      x: gate.x, z: gate.z, headingDeg: 0, activity: 'productive' as SiteTwinActivity,
      path, engagedLabel: null, breakdown: false,
    }))];
  }, [machines, twin?.simulated, draft, zones, t]);

  const [focusMachine, setFocusMachine] = useState<string | null>(null);
  const focus: SceneFocus = useMemo(() => {
    const fm = focusMachine ? machines.find((m) => m.key === focusMachine) : null;
    if (fm) return { x: fm.x, z: fm.z, widthM: 50, depthM: 36 };
    const z = zones[focusIndex];
    if (z) return { x: z.x, z: z.z, widthM: z.widthM * 1.3, depthM: z.depthM * 1.3 };
    const lane = machines.some((m) => !m.placed) ? 28 : 0;
    return { x: 0, z: lane / 2, widthM: extent.widthM, depthM: extent.depthM + lane };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones, focusIndex, extent, focusMachine, machines.length]);

  const onDrag = useCallback((target: DragTarget, x: number, z: number) => {
    setDraft((d) => {
      if (!d) return d;
      const hw = d.extent.widthM / 2; const hd = d.extent.depthM / 2;
      if (target.kind === 'machine') {
        const positions = new Map(d.positions);
        const prev = positions.get(target.key);
        positions.set(target.key, { x: round1(clamp(x, -hw + 2, hw - 2)), z: round1(clamp(z, -hd + 2, hd - 2)), headingDeg: prev?.headingDeg ?? 0, route: prev?.route ?? [] });
        return { ...d, positions };
      }
      const zones2 = d.zones.slice();
      const zn = zones2[target.index];
      zones2[target.index] = {
        ...zn,
        x: round1(clamp(x, -hw + zn.widthM / 2, hw - zn.widthM / 2)),
        z: round1(clamp(z, -hd + zn.depthM / 2, hd - zn.depthM / 2)),
      };
      return { ...d, zones: zones2 };
    });
  }, []);

  const startEdit = () => {
    if (!twin) return;
    const positions = new Map<string, Pos>();
    // A route stop the twin no longer draws (its structure lost its machine) would be
    // refused on save; drop it here rather than there.
    const keys = new Set(twin.zones.map((z) => z.key));
    for (const m of twin.machines) if (m.placement) positions.set(mkey(m), { ...m.placement, route: m.placement.route.filter((k) => keys.has(k)) });
    setDraft({ extent: { ...twin.extent }, zones: twin.zones.map((z) => ({ ...z })), positions });
    setSaveError(undefined);
    setAutoRotate(false);
  };

  const save = async () => {
    if (!twin || !draft) return;
    setSaving(true); setSaveError(undefined);
    try {
      const fresh = await apiSaveSiteTwinLayout(plantId, {
        expectedVersion: twin.version,
        extent: draft.extent,
        zones: draft.zones.map(zoneBody),
        placements: twin.machines.flatMap((m) => {
          const p = draft.positions.get(mkey(m));
          return p ? [{ sourceSystem: m.sourceSystem, externalId: m.externalId, ...p }] : [];
        }),
      });
      setTwin(fresh); setDraft(null);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : t('siteTwin.saveFailed', { defaultValue: 'The layout could not be saved.' }));
    } finally {
      setSaving(false);
    }
  };

  const setZone = (i: number, patch: Partial<SiteTwinZone>) =>
    setDraft((d) => (d ? { ...d, zones: d.zones.map((z, j) => (j === i ? { ...z, ...patch } : z)) } : d));
  const turn = (key: string, by: number) => setDraft((d) => {
    const p = d?.positions.get(key);
    if (!d || !p) return d;
    const positions = new Map(d.positions);
    positions.set(key, { ...p, headingDeg: (((p.headingDeg + by) % 360) + 360) % 360 });
    return { ...d, positions };
  });
  const unplace = (key: string) => setDraft((d) => {
    if (!d) return d;
    const positions = new Map(d.positions); positions.delete(key);
    return { ...d, positions };
  });
  const placeAtCentre = (key: string) => setDraft((d) => {
    if (!d) return d;
    const positions = new Map(d.positions); positions.set(key, { x: 0, z: 0, headingDeg: 0, route: [] });
    return { ...d, positions };
  });

  const setRoute = (key: string, route: string[]) => setDraft((d) => {
    const p = d?.positions.get(key);
    if (!d || !p) return d;
    const positions = new Map(d.positions); positions.set(key, { ...p, route });
    return { ...d, positions };
  });
  // Deleting a zone takes it out of every route too, or the save would be refused.
  const removeZone = (i: number) => setDraft((d) => {
    if (!d) return d;
    const gone = d.zones[i].key;
    const positions = new Map([...d.positions].map(([k, p]) => [k, { ...p, route: p.route.filter((r) => r !== gone) }]));
    return { ...d, zones: d.zones.filter((_, j) => j !== i), positions };
  });
  // Arrange the site's own machines around what is drawn: the composer puts each at its
  // work front, keeps every zone in the draft, adds only the structures still missing, and
  // sends anything that needs a person to the maintenance and breakdown bay. It used to
  // start from nothing, and a zone drawn a moment before was gone (4 Nov).
  const [composing, setComposing] = useState(false);
  const compose = async () => {
    if (!draft) return;
    setComposing(true); setSaveError(undefined);
    try {
      const p = await apiArrangeSiteTwinAround(plantId, { extent: draft.extent, zones: draft.zones.map(zoneBody) });
      const positions = new Map<string, Pos>(p.placements.map((pl) => [`${pl.sourceSystem}/${pl.externalId}`, { x: pl.x, z: pl.z, headingDeg: pl.headingDeg, route: pl.route ?? [] }]));
      setDraft({ extent: p.extent, zones: p.zones.map((z) => ({ ...z })), positions });
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : t('siteTwin.composeFailed', { defaultValue: 'A layout could not be composed.' }));
    } finally {
      setComposing(false);
    }
  };

  const newKey = (zs: SiteTwinZone[]) => {
    let n = zs.length + 1;
    while (zs.some((z) => z.key === `zone-${n}`)) n += 1;
    return `zone-${n}`;
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void frame.current?.requestFullscreen();
  };

  // Only a first load that fails replaces the card: a refresh that fails every 20 s used to
  // swap a working twin for an error box. It keeps the last answer and says it is stale.
  if (error && !twin) {
    return (
      <div className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2.5">
        <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
      </div>
    );
  }
  if (!twin) return <div className="h-[520px] rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />;
  // Names off unless asked for: a machine's own shows on hover and when selected.
  const labelsOn = showLabels ?? false;

  // Nothing is assigned here: there is no site to draw, and a yard of offices would be
  // a picture of plant this site does not have.
  if (!twin.machines.length && !twin.zones.length) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-5 text-sm text-slate-500 flex items-center gap-2">
        <Box className="w-4 h-4 text-slate-400" />
        {t('siteTwin.noMachines', { defaultValue: 'No machines are assigned to this site yet, so its digital twin has nothing to show. Assign equipment to the site and it appears here.' })}
      </div>
    );
  }

  const sel = selected ? twin.machines.find((m) => mkey(m) === selected) ?? null : null;
  const selPlaced = sel ? (draft ? draft.positions.has(mkey(sel)) : !!sel.placement) : false;
  const btn = 'p-2 rounded-lg bg-white/95 dark:bg-slate-800/95 shadow border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700';

  return (
    <div ref={frame} className={`bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden ${fullscreen ? 'flex flex-col h-screen' : ''}`}>
      {/* ---------------------------------------------------------------- header */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-9 h-9 rounded-lg bg-sky-600 text-white flex items-center justify-center shrink-0"><Box className="w-5 h-5" /></span>
          <div className="min-w-0">
            <div className="text-sm font-bold text-slate-900 dark:text-slate-100">{t('siteTwin.title', { defaultValue: 'Site digital twin' })}</div>
            <div className="text-xs text-slate-500 truncate">
              {twin.site.name} · {twin.site.code}{twin.site.address ? ` · ${twin.site.address}` : ''} · {extent.widthM} × {extent.depthM} m
            </div>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5 text-xs">
          {twin.simulated && (
            <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300 font-semibold" title={t('siteTwin.simulatedHint', { defaultValue: 'Demo account: machine movement and haul trips are simulated. Status, alerts and progress come from the platform.' })}>
              {t('siteTwin.simulated', { defaultValue: 'Demo · simulated movement' })}
            </span>
          )}
          <span className="px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-800 font-semibold text-slate-700 dark:text-slate-200">
            {t('siteTwin.onSite', { count: twin.summary.total })}
          </span>
          {(['productive', 'idle'] as SiteTwinActivity[]).map((a) => {
            const n = twin.machines.filter((m) => m.activity === a).length;
            return n ? (
              <span key={a} className="px-2.5 py-1 rounded-full bg-slate-50 dark:bg-slate-800 flex items-center gap-1.5 text-slate-700 dark:text-slate-200">
                <span className="w-2 h-2 rounded-sm" style={{ background: ACTIVITY_COLOUR[a] }} /> {n} {activityLabel(a)}
              </span>
            ) : null;
          })}
          {STATUS_ORDER.filter((s) => twin.summary[s] > 0).map((s) => (
            <span key={s} className="px-2.5 py-1 rounded-full border border-slate-200 dark:border-slate-700 flex items-center gap-1.5 text-slate-700 dark:text-slate-200">
              <span className="w-2 h-2 rounded-full" style={{ background: STATUS_COLOUR[s] }} /> {twin.summary[s]} {statusLabel(s)}
            </span>
          ))}
        </div>
      </div>

      {/* ------------------------------------------------- place and equipment */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{t('siteTwin.refreshFailed', { error })}</span>
        </div>
      )}
      {/* Two pickers rather than a row of tabs: a big site has twenty places and sixty
          machines, and a picker holds them all without running off the card. */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-slate-100 dark:border-slate-800">
        <label className="flex items-center gap-1.5 text-xs text-slate-500 w-full sm:w-auto">
          {t('siteTwin.placePicker', { defaultValue: 'Place' })}
          <select
            value={focusMachine ? '' : String(focusIndex)}
            onChange={(e) => { setFocusMachine(null); setSelected(null); setFocusIndex(Number(e.target.value)); }}
            className="px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 font-semibold min-w-0 flex-1 sm:flex-none sm:max-w-[260px]"
          >
            <option value="-1">{t('siteTwin.overview', { defaultValue: 'Whole site' })}</option>
            {zones.map((z, i) => <option key={z.key} value={String(i)}>{z.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 w-full sm:w-auto">
          {t('siteTwin.equipment', { defaultValue: 'Equipment' })}
          <select
            value={focusMachine ?? ''}
            onChange={(e) => {
              const k = e.target.value || null;
              setFocusMachine(k); setSelected(k);
              if (!k) setFocusIndex(-1);
            }}
            className="px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 font-semibold min-w-0 flex-1 sm:flex-none sm:max-w-[300px]"
          >
            <option value="">{t('siteTwin.allEquipment', { defaultValue: 'All equipment' })}</option>
            {[...twin.machines].sort((x, y) => (x.name ?? x.externalId).localeCompare(y.name ?? y.externalId)).map((m) => (
              <option key={mkey(m)} value={mkey(m)}>
                {(m.name ?? m.externalId).slice(0, 48)} · {statusLabel(m.status)}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-2 pl-3">
          {canEdit && !draft && (
            <button onClick={startEdit} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-600 text-white hover:bg-sky-700 flex items-center gap-1.5 whitespace-nowrap">
              <Move className="w-3.5 h-3.5" /> {t('siteTwin.edit', { defaultValue: 'Edit layout' })}
            </button>
          )}
          {draft && (
            <>
              <button onClick={() => { setDraft(null); setSaveError(undefined); }} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap">
                <X className="w-3.5 h-3.5" /> {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button disabled={saving} onClick={() => void save()} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 flex items-center gap-1.5 whitespace-nowrap">
                <Save className="w-3.5 h-3.5" /> {saving ? t('siteTwin.saving', { defaultValue: 'Saving…' }) : t('siteTwin.save', { defaultValue: 'Save layout' })}
              </button>
            </>
          )}
        </div>
      </div>

      {focusIndex >= 0 && zones[focusIndex] && !draft && (() => {
        const z = zones[focusIndex];
        const here = twin.machines.filter((m) => m.engagedAt === z.key);
        return (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs bg-slate-50 dark:bg-slate-800/60 border-b border-slate-100 dark:border-slate-800">
            <span className="font-semibold text-slate-800 dark:text-slate-100">{z.label}</span>
            <span className="text-slate-500">{zoneLabel(z.kind)} · {t('siteTwin.zoneSize', { w: z.widthM, d: z.depthM })}{z.floors ? ` · ${t('siteTwin.floorsCount', { count: z.floors })}` : ''}</span>
            {SITE_PROGRESS_KINDS.includes(z.kind) && (
              z.progressPct !== null && z.progressPct !== undefined ? (
                <span className="flex items-center gap-2">
                  <span className="w-28 h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                    <span className="block h-full bg-emerald-500" style={{ width: `${z.progressPct}%` }} />
                  </span>
                  <span className="font-semibold text-slate-700 dark:text-slate-200">{z.progressPct.toFixed(1)}%</span>
                  {z.progressReportedAt && (
                    <span className="text-slate-500">
                      {t('siteTwin.reportedOn', { defaultValue: 'reported {{when}}', when: new Date(z.progressReportedAt).toLocaleString(appLocale()) })}
                    </span>
                  )}
                </span>
              ) : <span className="text-amber-700 dark:text-amber-300">{t('siteTwin.progressNotReported', { defaultValue: 'Progress not reported' })}</span>
            )}
            <span className="text-slate-600 dark:text-slate-300">
              {here.length
                ? `${t('siteTwin.engagedHere', { defaultValue: 'Engaged here' })}: ${here.map((m) => `${m.name ?? m.externalId} (${activityLabel(m.activity)})`).join(', ')}`
                : t('siteTwin.noneEngaged', { defaultValue: 'No machine engaged here' })}
            </span>
          </div>
        );
      })()}

      {saveError && (
        <div className="flex items-center gap-2 text-xs text-rose-700 bg-rose-50 dark:bg-rose-950/40 dark:text-rose-300 px-4 py-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {saveError}
        </div>
      )}
      {!twin.saved && !draft && (
        <div className="text-xs text-amber-800 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300 px-4 py-2">
          {canEdit
            ? t('siteTwin.notLaidOutEditor', { defaultValue: 'This site has not been laid out yet. Choose "Edit layout" to set its size, draw its zones and place each machine.' })
            : t('siteTwin.notLaidOut', { defaultValue: 'This site has not been laid out yet. The machines are shown in a row until an administrator places them.' })}
        </div>
      )}

      <div className={`relative flex flex-col sm:flex-row ${fullscreen ? 'flex-1 min-h-0' : ''}`}>
        {/* ------------------------------------------------------------- canvas */}
        {/* flex-1 only side by side: stacked on a phone it took the height to nothing (150 px).
            min-w-0 so it makes room for the layout editor: without it the canvas kept its
            full width and pushed the editor (Add zone, the site size, every zone) off the
            card's right edge, out of sight. */}
        <div className={`relative w-full min-w-0 sm:flex-1 ${fullscreen ? 'h-full' : 'h-[440px] sm:h-[640px]'}`}>
          <Suspense fallback={<div className="absolute inset-0 bg-slate-100 dark:bg-slate-800 animate-pulse" />}>
            <SiteTwinScene
              extent={extent} zones={zones} machines={shown}
              // The demo tippers use the stand-in model the frontend ships, not a class copy.
              classModels={twin.simulated ? { 'rock-tipper-truck': { modelUrl: '/models/classes/rock-tipper-truck.glb', bounds: null }, ...twin.classModels } : twin.classModels}
              showLabels={labelsOn} selectedKey={selected} onSelect={setSelected}
              editing={!!draft} onDrag={onDrag} focus={focus} zoomCommand={zoom} autoRotate={autoRotate}
              simulated={twin.simulated}
            />
          </Suspense>

          <div className="absolute top-3 right-3 flex flex-col gap-1.5">
            <button className={btn} title={t('siteTwin.zoomIn', { defaultValue: 'Zoom in' })} onClick={() => setZoom((z) => ({ n: z.n + 1, dir: 1 }))}><Plus className="w-4 h-4" /></button>
            <button className={btn} title={t('siteTwin.zoomOut', { defaultValue: 'Zoom out' })} onClick={() => setZoom((z) => ({ n: z.n + 1, dir: -1 }))}><Minus className="w-4 h-4" /></button>
            <button className={btn} title={t('siteTwin.resetView', { defaultValue: 'Reset view' })} onClick={() => { setFocusIndex(-1); setZoom((z) => ({ n: z.n + 1, dir: 0 })); }}><RotateCcw className="w-4 h-4" /></button>
            <button className={btn} title={t('siteTwin.labels', { defaultValue: 'Show or hide labels' })} onClick={() => setShowLabels(!labelsOn)}>{labelsOn ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}</button>
            {!draft && (
              <button className={btn} title={t('siteTwin.tour', { defaultValue: 'Rotate slowly' })} onClick={() => setAutoRotate((v) => !v)}>{autoRotate ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}</button>
            )}
            <button className={btn} title={t('siteTwin.fullscreen', { defaultValue: 'Full screen' })} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}</button>
          </div>

          {/* --------------------------------------------------------- legend */}
          {/* On a phone the legend keeps the statuses and the route note; the zone kinds
              are on the ground already, and the full legend covered most of the scene. */}
          <div className="absolute bottom-3 left-3 bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-700 rounded-lg shadow px-3 py-2 text-xs text-slate-700 dark:text-slate-200 space-y-1 max-w-[calc(100%-4.5rem)] sm:max-w-[60%]">
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {STATUS_ORDER.map((s) => (
                <span key={s} className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ background: STATUS_COLOUR[s] }} /> {statusLabel(s)}</span>
              ))}
            </div>
            {zones.length > 0 && (
              <div className="hidden sm:flex flex-wrap gap-x-3 gap-y-1 pt-1 border-t border-slate-100 dark:border-slate-800">
                {[...new Set(zones.map((z) => z.kind))].map((k) => (
                  <span key={k} className="flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm" style={{ background: ZONE_COLOUR[k] }} /> {zoneLabel(k)}</span>
                ))}
              </div>
            )}
            {!draft && twin.machines.some((m) => m.placement && m.placement.route.length) && (
              <div className="text-slate-500 pt-1 border-t border-slate-100 dark:border-slate-800">
                {t('siteTwin.routeNote', { defaultValue: 'Dashed line: illustrative route, travelled while the machine’s data is live and nothing says it is stopped. Not GPS.' })}
              </div>
            )}
            {draft && <div className="text-sky-700 dark:text-sky-300 pt-1">{t('siteTwin.dragHint', { defaultValue: 'Drag a machine or a zone to move it.' })}</div>}
          </div>

          {/* --------------------------------------------------- selected machine */}
          {sel && (
            <div className="absolute top-3 left-3 w-64 bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg p-3 text-xs space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-bold text-sm text-slate-900 dark:text-slate-100 truncate">{sel.name ?? sel.externalId}</div>
                  <div className="text-slate-500 truncate">{sel.externalId}{sel.classSlug ? ` · ${sel.classSlug}` : ''}</div>
                </div>
                <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
              </div>
              <div className={`flex items-center gap-1.5 font-semibold ${STATUS_TEXT[sel.status]}`}>
                <span className="w-2 h-2 rounded-full" style={{ background: STATUS_COLOUR[sel.status] }} /> {statusLabel(sel.status)}
                {sel.openAlerts > 0 && <span className="text-slate-500 font-normal">· {t('siteTwin.openAlerts', { count: sel.openAlerts })}</span>}
              </div>
              <div className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                <span className="w-2 h-2 rounded-full" style={{ background: sel.breakdown ? '#e11d48' : ACTIVITY_COLOUR[sel.activity] }} />
                {sel.breakdown ? t('siteTwin.breakdown', { defaultValue: 'Breakdown' }) : activityLabel(sel.activity)}
                {sel.engagedAt && <span>· {t('siteTwin.engagedAt', { defaultValue: 'at {{zone}}', zone: zones.find((z) => z.key === sel.engagedAt)?.label ?? sel.engagedAt })}</span>}
              </div>
              {draft && selPlaced && (() => {
                const route = draft.positions.get(mkey(sel))!.route;
                return (
                  <div className="space-y-1">
                    <div className="text-slate-500">{t('siteTwin.route', { defaultValue: 'Route while working (illustrative)' })}</div>
                    <div className="flex flex-wrap gap-1">
                      {route.map((k, i) => (
                        <span key={`${k}-${i}`} className="px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 flex items-center gap-1">
                          {i + 1}. {zones.find((z) => z.key === k)?.label ?? k}
                          <button onClick={() => setRoute(mkey(sel), route.filter((_, j) => j !== i))}><X className="w-3 h-3" /></button>
                        </span>
                      ))}
                    </div>
                    {route.length < 8 && zones.length > 0 && (
                      <select
                        value="" onChange={(e) => { if (e.target.value) setRoute(mkey(sel), [...route, e.target.value]); }}
                        className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                      >
                        <option value="">{t('siteTwin.addStop', { defaultValue: '+ Add a stop' })}</option>
                        {zones.map((z) => <option key={z.key} value={z.key}>{z.label}</option>)}
                      </select>
                    )}
                  </div>
                );
              })()}
              {draft ? (
                selPlaced ? (
                  <div className="flex items-center gap-1.5">
                    <button className={btn} title={t('siteTwin.turnLeft', { defaultValue: 'Turn 15° left' })} onClick={() => turn(mkey(sel), -15)}><RotateCcw className="w-3.5 h-3.5" /></button>
                    <button className={btn} title={t('siteTwin.turnRight', { defaultValue: 'Turn 15° right' })} onClick={() => turn(mkey(sel), 15)}><RotateCw className="w-3.5 h-3.5" /></button>
                    <button onClick={() => unplace(mkey(sel))} className="ml-auto px-2 py-1.5 rounded-lg text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 font-semibold">
                      {t('siteTwin.unplace', { defaultValue: 'Take off site' })}
                    </button>
                  </div>
                ) : (
                  <button onClick={() => placeAtCentre(mkey(sel))} className="w-full px-2 py-1.5 rounded-lg bg-sky-600 text-white font-semibold hover:bg-sky-700">
                    {t('siteTwin.place', { defaultValue: 'Place on site' })}
                  </button>
                )
              ) : (
                <button
                  onClick={() => navigate(`/admin/equipment/${encodeURIComponent(sel.sourceSystem)}/${encodeURIComponent(sel.externalId)}/page`)}
                  className="w-full px-2 py-1.5 rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-semibold"
                >
                  {t('siteTwin.openMachine', { defaultValue: 'Open machine page' })}
                </button>
              )}
            </div>
          )}
        </div>

        {/* ------------------------------------------------------- layout editor */}
        {draft && (
          <aside className={`w-full sm:w-72 shrink-0 border-t sm:border-t-0 sm:border-l border-slate-200 dark:border-slate-800 p-3 space-y-3 overflow-y-auto text-xs ${fullscreen ? '' : 'sm:max-h-[640px]'}`}>
            <button
              disabled={composing} onClick={() => void compose()}
              className="w-full px-3 py-2 rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-semibold disabled:opacity-60"
            >
              {composing ? t('siteTwin.composing', { defaultValue: 'Composing…' }) : t('siteTwin.compose', { defaultValue: 'Auto-arrange from equipment' })}
            </button>
            <p className="text-slate-500 -mt-1">
              {t('siteTwin.composeHint', { defaultValue: 'Arranges the machines assigned to this site around what is drawn: every zone here stays as it is, only the structures still missing are added, and anything needing attention goes to the breakdown bay. Machine positions are rearranged; nothing is saved until you save.' })}
            </p>
            <div>
              <div className="font-semibold text-slate-800 dark:text-slate-100 mb-1.5">{t('siteTwin.siteSize', { defaultValue: 'Site size (metres)' })}</div>
              <div className="grid grid-cols-2 gap-2">
                {(['widthM', 'depthM'] as const).map((k) => (
                  <label key={k} className="space-y-0.5">
                    <span className="text-slate-500">{k === 'widthM' ? t('siteTwin.width', { defaultValue: 'Width (E–W)' }) : t('siteTwin.depth', { defaultValue: 'Depth (N–S)' })}</span>
                    <input
                      type="number" min={10} max={5000} value={draft.extent[k]}
                      onChange={(e) => setDraft((d) => (d ? { ...d, extent: { ...d.extent, [k]: Number(e.target.value) } } : d))}
                      className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-800 dark:text-slate-100">{t('siteTwin.zones', { defaultValue: 'Zones' })}</span>
              <button
                onClick={() => setDraft((d) => (d ? {
                  ...d,
                  zones: [...d.zones, {
                    key: newKey(d.zones), label: t('siteTwin.newZone', { defaultValue: 'New zone' }), kind: 'work_area' as SiteZoneKind, x: 0, z: 0,
                    widthM: Math.min(30, d.extent.widthM), depthM: Math.min(20, d.extent.depthM),
                  }],
                } : d))}
                className="px-2 py-1 rounded-lg bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300 font-semibold flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> {t('siteTwin.addZone', { defaultValue: 'Add zone' })}
              </button>
            </div>
            {draft.zones.length === 0 && <p className="text-slate-400">{t('siteTwin.noZones', { defaultValue: 'No zones yet.' })}</p>}
            {draft.zones.map((z, i) => (
              <div key={i} className="rounded-lg border border-slate-200 dark:border-slate-700 p-2 space-y-1.5" style={{ borderLeft: `4px solid ${ZONE_COLOUR[z.kind]}` }}>
                <div className="flex items-center gap-1.5">
                  <input
                    value={z.label} maxLength={60} onChange={(e) => setZone(i, { label: e.target.value })}
                    className="flex-1 min-w-0 px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 font-semibold"
                  />
                  <button onClick={() => removeZone(i)} className="text-slate-400 hover:text-rose-600"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
                <select
                  value={z.kind} onChange={(e) => setZone(i, { kind: e.target.value as SiteZoneKind })}
                  className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                >
                  <optgroup label={t('siteTwin.structures', { defaultValue: 'Structures (3-D)' })}>
                    {SITE_STRUCTURE_KINDS.map((k) => <option key={k} value={k}>{zoneLabel(k)}</option>)}
                  </optgroup>
                  <optgroup label={t('siteTwin.areas', { defaultValue: 'Areas (on the ground)' })}>
                    {SITE_AREA_KINDS.map((k) => <option key={k} value={k}>{zoneLabel(k)}</option>)}
                  </optgroup>
                </select>
                {(z.kind === 'building' || SITE_PROGRESS_KINDS.includes(z.kind)) && (
                  <div className="grid grid-cols-2 gap-1.5">
                    {z.kind === 'building' && (
                      <label className="space-y-0.5">
                        <span className="text-slate-500">{t('siteTwin.floors', { defaultValue: 'Floors planned' })}</span>
                        <input
                          type="number" min={1} max={80} value={z.floors ?? ''} onChange={(e) => setZone(i, { floors: e.target.value ? Number(e.target.value) : null })}
                          className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                        />
                      </label>
                    )}
                    <label className="space-y-0.5">
                      <span className="text-slate-500">{t('siteTwin.progress', { defaultValue: 'Progress %' })}</span>
                      <input
                        type="number" min={0} max={100} value={z.progressPct ?? ''} placeholder={t('siteTwin.notReported', { defaultValue: 'not reported' })}
                        onChange={(e) => setZone(i, { progressPct: e.target.value === '' ? null : Number(e.target.value) })}
                        className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                      />
                    </label>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-1.5">
                  {(['widthM', 'depthM'] as const).map((k) => (
                    <label key={k} className="space-y-0.5">
                      <span className="text-slate-500">{k === 'widthM' ? t('siteTwin.width', { defaultValue: 'Width (E–W)' }) : t('siteTwin.depth', { defaultValue: 'Depth (N–S)' })}</span>
                      <input
                        type="number" min={1} value={z[k]} onChange={(e) => setZone(i, { [k]: Number(e.target.value) })}
                        className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}

            <div className="pt-2 border-t border-slate-200 dark:border-slate-800 text-slate-500">
              {t('siteTwin.placedCount', {
                defaultValue: '{{placed}} of {{total}} machines placed. Select one in the "Not yet placed" row and choose "Place on site", then drag it into position.',
                placed: draft.positions.size, total: twin.machines.length,
              })}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
};
