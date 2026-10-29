import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, MapPin, RotateCw } from 'lucide-react';
import { SelectPicker } from 'rsuite';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Chip, ChipTone } from '../components/common/Chip';
import {
  ApiError, GeofenceFleetMachine, GeofenceFleetStatus, GeofenceFleetZone, GeofenceShape, apiGeofenceFleetStatus,
} from '../lib/api';

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
 * Metres east and north of an origin. A site is a few kilometres across, where a flat
 * projection is off by far less than a GPS fix — and it lets the SVG draw a circle's
 * radius and a corridor's width in their own units.
 */
function projector([lng0, lat0]: [number, number]) {
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return ([lng, lat]: [number, number]): [number, number] => [(lng - lng0) * kx, -(lat - lat0) * 110_574];
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

  const load = () => {
    setLoading(true);
    return apiGeofenceFleetStatus()
      .then((s) => { setStatus(s); setError(undefined); })
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
  const zones = useMemo(() => {
    const keys = new Set(here.flatMap((m) => m.zones.map((z) => z.key)));
    if (siteId) keys.add(`site:${siteId}`);
    return (status?.zones ?? []).filter((z) => keys.has(z.key));
  }, [status, here, siteId]);

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
          onChange={(v) => { setSiteId(v); setSelected(null); }}
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
            zones={zones}
            machines={here}
            selected={selected}
            onSelect={setSelected}
            emptyText={status ? t('geofence.noSites') : t('geofence.loading')}
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
          {selectedMachine && (
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
  zones: GeofenceFleetZone[];
  machines: GeofenceFleetMachine[];
  selected: string | null;
  onSelect: (key: string) => void;
  emptyText: string;
}> = ({ zones, machines, selected, onSelect, emptyText }) => {
  const boundary = zones.find((z) => z.source === 'site-boundary');
  const fencePoints = (boundary ? [boundary] : zones).flatMap((z) => shapePoints(z.shape));
  const positioned = machines.filter((m) => m.position);
  const anchor: [number, number][] = fencePoints.length ? fencePoints : positioned.map((m) => [m.position!.lng, m.position!.lat]);

  if (!anchor.length) {
    return (
      <div className="aspect-square max-h-[640px] w-full flex flex-col items-center justify-center gap-2 text-sm text-slate-500 dark:text-slate-400">
        <MapPin className="w-6 h-6" />{emptyText}
      </div>
    );
  }

  const centre: [number, number] = [
    anchor.reduce((a, p) => a + p[0], 0) / anchor.length,
    anchor.reduce((a, p) => a + p[1], 0) / anchor.length,
  ];
  const project = projector(centre);
  // Sized to the fence, with a margin; a machine far beyond it is pinned to the edge with
  // its distance, so a haul trip does not shrink the site to a dot.
  const fenceXY = anchor.map(project);
  const half = Math.max(400, ...fenceXY.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y)))) * 1.25;
  const edge = half * 0.94;
  const clamp = (v: number) => Math.max(-edge, Math.min(edge, v));
  const grid = half > 2000 ? 1000 : half > 800 ? 500 : 200;
  const lines: number[] = [];
  for (let v = -Math.floor(half / grid) * grid; v <= half; v += grid) lines.push(v);
  const r = half / 55;

  const order = [...positioned].sort((a, b) => Number(a.violating) - Number(b.violating));

  return (
    <svg viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`} className="block w-full h-auto aspect-square max-h-[640px]" role="img">
      {lines.map((v) => (
        <g key={v}>
          <line x1={v} y1={-half} x2={v} y2={half} className="stroke-slate-200 dark:stroke-slate-800" strokeWidth={half / 600} />
          <line x1={-half} y1={v} x2={half} y2={v} className="stroke-slate-200 dark:stroke-slate-800" strokeWidth={half / 600} />
        </g>
      ))}
      {zones.map((z) => <ZoneShape key={z.key} zone={z} project={project} unit={half / 400} />)}
      {order.map((m) => {
        const key = `${m.sourceSystem}/${m.externalId}`;
        const [x, y] = project([m.position!.lng, m.position!.lat]);
        const off = Math.abs(x) > edge || Math.abs(y) > edge;
        const s = stateOf(m);
        return (
          <g
            key={key}
            transform={`translate(${clamp(x)},${clamp(y)})`}
            onClick={() => onSelect(key)}
            className="cursor-pointer"
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
                {`${(Math.hypot(x, y) / 1000).toFixed(1)} km`}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

const ZoneShape: React.FC<{ zone: GeofenceFleetZone; project: (p: [number, number]) => [number, number]; unit: number }> = ({ zone, project, unit }) => {
  const restricted = zone.kind === 'restricted';
  const stroke = restricted ? 'stroke-rose-500' : 'stroke-slate-500 dark:stroke-slate-400';
  const fill = restricted ? 'fill-rose-500/15' : 'fill-none';
  const s = zone.shape;
  if (s.type === 'Circle') {
    const [cx, cy] = project(s.center);
    return <circle cx={cx} cy={cy} r={s.radiusM} className={`${stroke} ${fill}`} strokeWidth={unit * 2} />;
  }
  if (s.type === 'Corridor') {
    const d = s.path.map(project).map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
    return <path d={d} className="stroke-sky-500/25 fill-none" strokeWidth={s.widthM} strokeLinecap="round" strokeLinejoin="round" />;
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
