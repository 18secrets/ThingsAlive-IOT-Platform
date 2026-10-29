import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, MapPin, PenLine, RotateCw } from 'lucide-react';
import { SelectPicker } from 'rsuite';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Chip, ChipTone } from '../components/common/Chip';
import {
  ApiError, EquipmentProfile, GeofenceFleetMachine, GeofenceFleetStatus, GeofenceFleetZone, GeofenceShape,
  GeofenceZoneRecord, apiGeofenceFleetStatus, apiListEquipment, apiListGeofences,
} from '../lib/api';
import { DrawZonePanel, ZoneDraft, draftShape } from '../components/geofence/DrawZonePanel';

/** Positions arrive at the loggers' cadence; polling faster shows nothing new. */
const REFRESH_MS = 60_000;

type MachineState = 'ok' | 'violating' | 'stale' | 'none';

const STATE_TONE: Record<MachineState, ChipTone> = { ok: 'emerald', violating: 'rose', stale: 'slate', none: 'slate' };
const STATE_FILL: Record<MachineState, string> = {
  ok: 'fill-emerald-500', violating: 'fill-rose-500', stale: 'fill-slate-400', none: 'fill-slate-300',
};

function stateOf(m: GeofenceFleetMachine): MachineState {
  if (m.positionStatus === 'none') return 'none';
  if (m.positionStatus === 'stale') return 'stale';
  return m.violating ? 'violating' : 'ok';
}

/**
 * Web Mercator metres from an origin — the projection map tiles are drawn in, so the fences
 * and machines sit exactly on the streets beneath them. Mercator stretches distances by
 * 1/cos(latitude); `metres` is that factor at the origin, for anything sized in real metres
 * (a circle's radius, a corridor's width, the scale bar). Over a site a few kilometres
 * across, it varies by far less than a GPS fix.
 */
const EARTH_R = 6_378_137;
const WORLD = 2 * Math.PI * EARTH_R;
const mercX = (lng: number) => (EARTH_R * lng * Math.PI) / 180;
const mercY = (lat: number) => EARTH_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

function projector([lng0, lat0]: [number, number]) {
  const x0 = mercX(lng0);
  const y0 = mercY(lat0);
  return ([lng, lat]: [number, number]): [number, number] => [mercX(lng) - x0, -(mercY(lat) - y0)];
}

function unprojector([lng0, lat0]: [number, number]) {
  const x0 = mercX(lng0);
  const y0 = mercY(lat0);
  return ([x, y]: [number, number]): [number, number] => [
    Math.round((((x + x0) / EARTH_R) * 180 / Math.PI) * 1e6) / 1e6,
    Math.round(((2 * Math.atan(Math.exp((y0 - y) / EARTH_R)) - Math.PI / 2) * 180 / Math.PI) * 1e6) / 1e6,
  ];
}

const metresAt = (lat: number) => 1 / Math.cos((lat * Math.PI) / 180);

interface PlanView { centre: [number, number]; half: number }

/**
 * The plan's centre and half-width in metres: sized to the site's fence, else to its zones,
 * else to its machines. Fixed while drawing — a plan that re-centred on every click would
 * move the next point away from where it was aimed.
 */
function planView(zones: GeofenceFleetZone[], machines: GeofenceFleetMachine[], fallback: [number, number] | null): PlanView | null {
  const boundary = zones.find((z) => z.source === 'site-boundary');
  const fence = (boundary ? [boundary] : zones).flatMap((z) => shapePoints(z.shape));
  const anchor: [number, number][] = fence.length ? fence
    : machines.filter((m) => m.position).map((m) => [m.position!.lng, m.position!.lat]);
  if (!anchor.length) return fallback ? { centre: fallback, half: 600 * metresAt(fallback[1]) } : null;
  const centre: [number, number] = [
    anchor.reduce((a, p) => a + p[0], 0) / anchor.length,
    anchor.reduce((a, p) => a + p[1], 0) / anchor.length,
  ];
  const project = projector(centre);
  const half = Math.max(400 * metresAt(centre[1]), ...anchor.map(project).map(([x, y]) => Math.max(Math.abs(x), Math.abs(y)))) * 1.25;
  return { centre, half };
}

function shapePoints(shape: GeofenceShape): [number, number][] {
  if (shape.type === 'Polygon') return shape.coordinates[0] ?? [];
  if (shape.type === 'Circle') return [shape.center];
  return shape.path;
}

/**
 * The fleet map (task QGEO2): every machine's latest position against its site boundary
 * and zones, from GET /geofences/fleet-status. A machine with no position is listed, not
 * drawn, and never counted as fine — unknown is not compliant.
 */
export const GeofenceMapPage: React.FC = () => {
  const { t } = useTranslation();
  usePageHeader({ title: t('pages.geofence.title'), subtitle: t('pages.geofence.subtitle') });
  const navigate = useNavigate();

  const [status, setStatus] = useState<GeofenceFleetStatus | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'machines' | 'zones'>('machines');
  const [draft, setDraft] = useState<ZoneDraft | null>(null);
  const [records, setRecords] = useState<GeofenceZoneRecord[]>([]);
  const [equipment, setEquipment] = useState<EquipmentProfile[]>([]);
  const [manualCentre, setManualCentre] = useState<[number, number] | null>(null);

  const load = () => {
    setLoading(true);
    return Promise.all([apiGeofenceFleetStatus(), apiListGeofences(), apiListEquipment()])
      .then(([s, z, e]) => { setStatus(s); setRecords(z); setEquipment(e); setError(undefined); })
      .catch((err) => setError(err instanceof ApiError ? err.message : t('geofence.loadFailed')))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sites = useMemo(() => {
    const bySite = new Map<string, { id: string; name: string; code: string; machines: number; violating: number }>();
    for (const m of status?.machines ?? []) {
      if (!m.site) continue;
      const s = bySite.get(m.site.id) ?? { ...m.site, machines: 0, violating: 0 };
      s.machines += 1;
      if (m.violating && m.positionStatus === 'live') s.violating += 1;
      bySite.set(m.site.id, s);
    }
    return [...bySite.values()].sort((a, b) => b.violating - a.violating || a.name.localeCompare(b.name));
  }, [status]);

  // Open on the site with the most machines breaking a rule; keep the person's choice after.
  useEffect(() => {
    if (!siteId && sites.length) setSiteId(sites[0].id);
  }, [sites, siteId]);

  const here = useMemo(
    () => (status?.machines ?? []).filter((m) => m.site?.id === siteId),
    [status, siteId],
  );

  const siteMachines = useMemo(() => equipment.filter((e) => e.plantId === siteId), [equipment, siteId]);
  // Every zone that touches this site: its own, its machines', its machine types', the account's.
  const siteRecords = useMemo(() => {
    const ids = new Set(siteMachines.map((m) => m.externalId));
    const types = new Set(siteMachines.map((m) => m.equipmentClassSlug).filter(Boolean));
    return records.filter((z) => z.appliesTo === 'account' || (z.appliesTo === 'plant' && z.plantId === siteId)
      || (z.appliesTo === 'equipment' && !!z.externalId && ids.has(z.externalId))
      || (z.appliesTo === 'equipment-class' && types.has(z.equipmentClassSlug)));
  }, [records, siteMachines, siteId]);
  // Drawn from the zone records, not from the machines' results: a machine with no position
  // has none, and its site's fences must still show.
  const zones = useMemo((): GeofenceFleetZone[] => [
    ...(status?.zones ?? []).filter((z) => z.key === `site:${siteId}`),
    ...siteRecords.filter((z) => z.enabled).map((z) => ({
      key: `zone:${z.id}`, id: z.id, source: 'zone' as const, code: z.code, name: z.name,
      kind: z.kind, shape: z.shape, appliesTo: z.appliesTo,
    })),
  ], [status, siteRecords, siteId]);
  const view = useMemo(() => planView(zones, here, manualCentre), [zones, here, manualCentre]);
  const currentSite = sites.find((s) => s.id === siteId) ?? null;
  const preview = draft ? draftShape(draft) : null;

  const selectedMachine = here.find((m) => `${m.sourceSystem}/${m.externalId}` === selected) ?? null;
  const summary = status?.summary;

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 rounded-md border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          <AlertCircle className="w-4 h-4 shrink-0" />{error}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label={t('geofence.stat.machines')} value={summary?.machines} />
        <Stat label={t('geofence.stat.live')} value={summary?.live} />
        <Stat label={t('geofence.stat.violating')} value={summary?.violating} tone="rose" />
        <Stat label={t('geofence.stat.stale')} value={summary?.stale} />
        <Stat label={t('geofence.stat.noPosition')} value={summary?.noPosition} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SelectPicker
          data={sites.map((s) => ({ label: `${s.name} (${s.machines})${s.violating ? ` · ${s.violating} ⚠` : ''}`, value: s.id }))}
          value={siteId}
          onChange={(v) => { setSiteId(v); setSelected(null); setDraft(null); setManualCentre(null); }}
          cleanable={false}
          searchable={sites.length > 8}
          placeholder={t('geofence.pickSite')}
          style={{ minWidth: 280 }}
        />
        <button
          type="button"
          onClick={() => load()}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          <RotateCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />{t('geofence.refresh')}
        </button>
        {status && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {t('geofence.updated', { time: new Date(status.asOf).toLocaleTimeString() })}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 overflow-hidden">
          <SiteMap
            view={view}
            zones={zones}
            machines={here}
            selected={selected}
            onSelect={setSelected}
            preview={preview}
            draftPoints={draft?.points ?? []}
            onPick={draft ? (p) => setDraft({ ...draft, mode: draft.mode, points: draft.mode === 'circle' ? [p] : [...draft.points, p] }) : undefined}
            onCentre={setManualCentre}
            // A failed load is said as one; "Loading" under an error reads as a page still working.
            emptyText={status ? t('geofence.noSites') : error ? t('geofence.notLoaded') : t('geofence.loading')}
          />
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
            <Legend fill="bg-emerald-500" label={t('geofence.legend.ok')} />
            <Legend fill="bg-rose-500" label={t('geofence.legend.violating')} />
            <Legend fill="bg-slate-400" label={t('geofence.legend.stale')} />
            <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 border-t-2 border-dashed border-slate-500" />{t('geofence.legend.boundary')}</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full border-2 border-rose-500 bg-rose-500/15" />{t('geofence.legend.noGo')}</span>
          </div>
        </div>

        <div className="space-y-3 min-w-0">
          <div className="grid grid-cols-2 rounded-md border border-slate-200 dark:border-slate-700 p-0.5 text-sm" role="tablist">
            {(['machines', 'zones'] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => { setTab(k); if (k === 'machines') setDraft(null); }}
                className={`inline-flex items-center justify-center gap-1.5 rounded px-3 py-1.5 font-medium ${tab === k
                  ? 'bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-600 dark:text-slate-300'}`}>
                {k === 'zones' && <PenLine className="w-4 h-4" />}{t(`geofence.tab.${k}`)}
              </button>
            ))}
          </div>

          {tab === 'zones' && currentSite && (
            <DrawZonePanel
              site={currentSite}
              machines={siteMachines}
              zones={siteRecords}
              draft={draft}
              onDraft={setDraft}
              onChanged={() => { load(); }}
            />
          )}

          {tab === 'machines' && selectedMachine && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 text-sm space-y-2">
              <div className="font-semibold text-slate-800 dark:text-slate-100 truncate">{selectedMachine.name ?? selectedMachine.externalId}</div>
              <MachineChip m={selectedMachine} />
              {selectedMachine.position && (
                <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                  {selectedMachine.position.lat.toFixed(5)}, {selectedMachine.position.lng.toFixed(5)} · {t('geofence.age', { minutes: Math.round(selectedMachine.position.ageSeconds / 60) })}
                </div>
              )}
              <ul className="space-y-1">
                {selectedMachine.zones.map((z) => {
                  const zone = status?.zones.find((x) => x.key === z.key);
                  return (
                    <li key={z.key} className="flex items-center justify-between gap-2">
                      <span className="truncate text-slate-700 dark:text-slate-300">{zone?.name ?? z.key}</span>
                      <Chip tone={z.violation ? 'rose' : 'emerald'}>{z.inside ? t('geofence.inside') : t('geofence.outside')}</Chip>
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                className="text-xs text-sky-600 dark:text-sky-400 hover:underline"
                onClick={() => navigate(`/dashboard/${encodeURIComponent(selectedMachine.sourceSystem)}/${encodeURIComponent(selectedMachine.externalId)}`)}
              >
                {t('geofence.openMachine')}
              </button>
            </div>
          )}

          {tab === 'machines' && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 text-sm font-semibold text-slate-700 dark:text-slate-200">
              {t('geofence.machinesHere', { count: here.length })}
            </div>
            <ul className="max-h-[480px] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
              {[...here]
                .sort((a, b) => rank(stateOf(a)) - rank(stateOf(b)) || a.externalId.localeCompare(b.externalId))
                .map((m) => {
                  const key = `${m.sourceSystem}/${m.externalId}`;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => setSelected(key)}
                        className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60 ${selected === key ? 'bg-slate-50 dark:bg-slate-800/60' : ''}`}
                      >
                        <span className="min-w-0 truncate text-slate-700 dark:text-slate-200">
                          {(m.name ?? m.externalId).split(' · ')[0]}
                          <span className="ml-1.5 text-xs text-slate-400 font-mono">{m.externalId}</span>
                        </span>
                        <MachineChip m={m} />
                      </button>
                    </li>
                  );
                })}
            </ul>
          </div>
          )}
        </div>
      </div>
    </div>
  );

  function MachineChip({ m }: { m: GeofenceFleetMachine }) {
    const s = stateOf(m);
    return <Chip tone={STATE_TONE[s]}>{t(`geofence.state.${s}`)}</Chip>;
  }
};

const rank = (s: MachineState) => ({ violating: 0, ok: 1, stale: 2, none: 3 }[s]);

const Stat: React.FC<{ label: string; value?: number; tone?: 'rose' }> = ({ label, value, tone }) => (
  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2">
    <div className={`text-2xl font-semibold tabular-nums ${tone === 'rose' && value ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100'}`}>
      {value ?? '—'}
    </div>
    <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
  </div>
);

const Legend: React.FC<{ fill: string; label: string }> = ({ fill, label }) => (
  <span className="inline-flex items-center gap-1.5"><span className={`inline-block w-2.5 h-2.5 rounded-full ${fill}`} />{label}</span>
);

/** The site in metres around its centre: fences first, machines on top, breakers last. */
const SiteMap: React.FC<{
  view: PlanView | null;
  zones: GeofenceFleetZone[];
  machines: GeofenceFleetMachine[];
  selected: string | null;
  onSelect: (key: string) => void;
  preview: GeofenceShape | null;
  draftPoints: [number, number][];
  onPick?: (p: [number, number]) => void;
  onCentre: (p: [number, number]) => void;
  emptyText: string;
}> = ({ view, zones, machines, selected, onSelect, preview, draftPoints, onPick, onCentre, emptyText }) => {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const [centreText, setCentreText] = useState('');

  if (!view) {
    // Nothing here has a place yet. Drawing needs one: let the person say where the site is.
    const parsed = centreText.split(',').map((v) => Number(v.trim()));
    const valid = parsed.length === 2 && parsed.every(Number.isFinite) && Math.abs(parsed[0]) <= 90 && Math.abs(parsed[1]) <= 180;
    return (
      <div className="aspect-square max-h-[640px] w-full flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-slate-500 dark:text-slate-400">
        <MapPin className="w-6 h-6" />{emptyText}
        <div className="flex flex-wrap justify-center gap-2">
          <input aria-label={t('geofence.draw.centreLabel')} placeholder="18.5204, 73.8567" value={centreText}
            onChange={(e) => setCentreText(e.target.value)}
            className="w-48 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-sm text-slate-800 dark:text-slate-100" />
          <button type="button" disabled={!valid} onClick={() => onCentre([parsed[1], parsed[0]])}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">{t('geofence.draw.centreGo')}</button>
        </div>
        <span className="text-xs">{t('geofence.draw.centreHint')}</span>
      </div>
    );
  }

  const { half } = view;
  const project = projector(view.centre);
  const unproject = unprojector(view.centre);
  const positioned = machines.filter((m) => m.position);
  // A machine far beyond the fence is pinned to the edge with its distance, so a haul trip
  // does not shrink the site to a dot.
  const edge = half * 0.94;
  const clamp = (v: number) => Math.max(-edge, Math.min(edge, v));
  const k = metresAt(view.centre[1]);
  const tiles = tilesFor(view);
  // A scale bar of a round length, about a fifth of the plan, in real metres.
  const barM = [100, 200, 250, 500, 1000, 2000, 5000].find((m) => m * k >= (half * 2) / 6) ?? 5000;
  const r = half / 55;
  const unit = half / 400;
  const order = [...positioned].sort((a, b) => Number(a.violating) - Number(b.violating));

  const pick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onPick || !svgRef.current) return;
    const ctm = svgRef.current.getScreenCTM();
    if (!ctm) return;
    const pt = svgRef.current.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const { x, y } = pt.matrixTransform(ctm.inverse());
    onPick(unproject([x, y]));
  };

  return (
    <div className="relative">
    <svg
      ref={svgRef}
      viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`}
      className={`block w-full h-auto aspect-square max-h-[640px] ${onPick ? 'cursor-crosshair' : ''}`}
      role="img"
      onClick={pick}
    >
      {/* OpenStreetMap beneath everything; darkened, not replaced, in the dark theme. */}
      <g className="dark:[filter:invert(0.9)_hue-rotate(180deg)_brightness(0.85)]" aria-hidden="true">
        {tiles.map((tl) => (
          <image key={tl.href} href={tl.href} x={tl.x} y={tl.y} width={tl.size} height={tl.size} preserveAspectRatio="none" />
        ))}
      </g>
      {zones.map((z) => <ZoneShape key={z.key} zone={z} project={project} unit={unit} k={k} />)}
      {preview && (
        <ZoneShape
          zone={{ key: 'draft', id: null, source: 'zone', code: 'draft', name: 'draft', kind: preview.type === 'Corridor' ? 'corridor' : 'restricted', shape: preview, appliesTo: 'plant' }}
          project={project}
          unit={unit}
          k={k}
          draft
        />
      )}
      {draftPoints.map((p, i) => {
        const [x, y] = project(p);
        return <circle key={i} cx={x} cy={y} r={r * 0.55} className="fill-sky-500 stroke-white dark:stroke-slate-900" strokeWidth={r / 5} />;
      })}
      {order.map((m) => {
        const key = `${m.sourceSystem}/${m.externalId}`;
        const [x, y] = project([m.position!.lng, m.position!.lat]);
        const off = Math.abs(x) > edge || Math.abs(y) > edge;
        const s = stateOf(m);
        return (
          <g
            key={key}
            transform={`translate(${clamp(x)},${clamp(y)})`}
            onClick={(e) => { if (onPick) return; e.stopPropagation(); onSelect(key); }}
            className={onPick ? '' : 'cursor-pointer'}
            role="button"
            tabIndex={0}
            aria-label={`${m.name ?? m.externalId}`}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(key); }}
          >
            <title>{`${m.name ?? m.externalId}`}</title>
            <circle
              r={selected === key ? r * 1.5 : r}
              className={`${STATE_FILL[s]} ${selected === key ? 'stroke-slate-900 dark:stroke-white' : 'stroke-white dark:stroke-slate-900'}`}
              strokeWidth={r / 3}
            />
            {off && (
              <text x={r * 1.6} y={r / 2} fontSize={r * 1.6} className="fill-amber-600 dark:fill-amber-400 font-mono">
                {`${(Math.hypot(x, y) / k / 1000).toFixed(1)} km`}
              </text>
            )}
          </g>
        );
      })}
      <g transform={`translate(${-half * 0.94},${half * 0.9})`}>
        <rect x={-unit * 4} y={-unit * 22} width={barM * k + unit * 8} height={unit * 30} className="fill-white/80 dark:fill-slate-900/80" />
        <line x1={0} y1={0} x2={barM * k} y2={0} className="stroke-slate-800 dark:stroke-slate-100" strokeWidth={unit * 2.5} />
        <text x={0} y={-unit * 6} fontSize={unit * 13} className="fill-slate-800 dark:fill-slate-100">
          {barM >= 1000 ? `${barM / 1000} km` : `${barM} m`}
        </text>
      </g>
    </svg>
    <a
      href="https://www.openstreetmap.org/copyright"
      target="_blank"
      rel="noreferrer"
      className="absolute bottom-1 right-1 rounded bg-white/85 dark:bg-slate-900/85 px-1.5 py-0.5 text-[10px] text-slate-600 dark:text-slate-300 hover:underline"
    >
      © OpenStreetMap contributors
    </a>
    </div>
  );
};

/** Map tiles are 256 px; aim for a few across a plan that renders some 600–800 px wide. */
const TILE_PX_TARGET = 0.32;

/**
 * The OpenStreetMap tiles under the plan, placed in its Mercator-metre coordinates. Light use
 * by a handful of people, inside OSM's tile policy; heavy production use belongs on a tile
 * provider, which is a change of URL here and nothing else.
 */
function tilesFor(view: PlanView): { href: string; x: number; y: number; size: number }[] {
  const { centre, half } = view;
  const z = Math.max(3, Math.min(19, Math.round(Math.log2(WORLD / (2 * half * TILE_PX_TARGET)))));
  const n = 2 ** z;
  const size = WORLD / n;
  const cx = mercX(centre[0]);
  const cy = mercY(centre[1]);
  const col = (x: number) => Math.floor((x + WORLD / 2) / size);
  const row = (y: number) => Math.floor((WORLD / 2 - y) / size);
  const out: { href: string; x: number; y: number; size: number }[] = [];
  for (let tx = col(cx - half); tx <= col(cx + half); tx += 1) {
    for (let ty = row(cy + half); ty <= row(cy - half); ty += 1) {
      if (ty < 0 || ty >= n) continue;
      const wrapped = ((tx % n) + n) % n;
      out.push({
        href: `https://tile.openstreetmap.org/${z}/${wrapped}/${ty}.png`,
        x: tx * size - WORLD / 2 - cx,
        y: -((WORLD / 2 - ty * size) - cy),
        size,
      });
    }
  }
  return out;
}

const ZoneShape: React.FC<{
  zone: GeofenceFleetZone; project: (p: [number, number]) => [number, number]; unit: number; k: number; draft?: boolean;
}> = ({ zone, project, unit, k, draft }) => {
  const restricted = zone.kind === 'restricted';
  // A shape still being drawn is blue, whatever it will be once saved. A site boundary is
  // dark and dashed with a faint wash, so it reads over a busy street map.
  const boundary = zone.source === 'site-boundary';
  const stroke = draft ? 'stroke-sky-500' : restricted ? 'stroke-rose-600' : boundary ? 'stroke-slate-800 dark:stroke-slate-100' : 'stroke-emerald-600';
  const fill = draft ? 'fill-sky-500/20' : restricted ? 'fill-rose-500/25' : boundary ? 'fill-slate-900/5 dark:fill-white/5' : 'fill-emerald-500/10';
  const s = zone.shape;
  if (s.type === 'Circle') {
    const [cx, cy] = project(s.center);
    return <circle cx={cx} cy={cy} r={s.radiusM * k} className={`${stroke} ${fill}`} strokeWidth={unit * 2} />;
  }
  if (s.type === 'Corridor') {
    const d = s.path.map(project).map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
    return <path d={d} className="stroke-sky-500/30 fill-none" strokeWidth={s.widthM * k} strokeLinecap="round" strokeLinejoin="round" />;
  }
  const rings = s.coordinates.map((ring) => ring.map(project).map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ') + ' Z');
  return (
    <path
      d={rings.join(' ')}
      fillRule="evenodd"
      className={`${stroke} ${fill}`}
      strokeWidth={unit * 2}
      strokeDasharray={zone.source === 'site-boundary' ? `${unit * 10} ${unit * 6}` : undefined}
    />
  );
};
