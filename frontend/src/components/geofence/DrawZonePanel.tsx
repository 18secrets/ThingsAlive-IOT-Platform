import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, Pencil, Trash2, Undo2, X } from 'lucide-react';
import { SelectPicker } from 'rsuite';
import { Chip } from '../common/Chip';
import {
  ApiError, EquipmentProfile, GeofenceShape, GeofenceZoneRecord,
  apiCreateGeofence, apiDeleteGeofence, apiSetPlantBoundary, apiUpdateGeofence,
} from '../../lib/api';

export type DraftMode = 'circle' | 'polygon' | 'corridor';

/** What is being drawn: the clicked points, [longitude, latitude], and the sizes typed in. */
export interface ZoneDraft {
  mode: DraftMode;
  points: [number, number][];
  radiusM: number;
  widthM: number;
}

type Target = 'plant' | 'equipment' | 'equipment-class' | 'account' | 'site-boundary';
type Kind = GeofenceZoneRecord['kind'];

const MIN_POINTS: Record<DraftMode, number> = { circle: 1, polygon: 3, corridor: 2 };

/** The shape a draft makes, or null while it has too few points. A polygon ring is closed here. */
export function draftShape(d: ZoneDraft): GeofenceShape | null {
  if (d.points.length < MIN_POINTS[d.mode]) return null;
  if (d.mode === 'circle') return { type: 'Circle', center: d.points[0], radiusM: d.radiusM };
  if (d.mode === 'corridor') return { type: 'Corridor', path: d.points, widthM: d.widthM };
  return { type: 'Polygon', coordinates: [[...d.points, d.points[0]]] };
}

const codeFrom = (name: string) =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'ZONE';

const inputClass = 'w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 '
  + 'text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40';
const labelClass = 'block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1';

/**
 * Drawing and managing zones on one site (task QGEO2). The plan does the clicking; this
 * holds the draft, says what it will apply to, and saves through the zone API. The
 * backend validates every shape and target; its refusal is shown as it words it.
 */
export const DrawZonePanel: React.FC<{
  site: { id: string; code: string; name: string };
  machines: EquipmentProfile[];
  zones: GeofenceZoneRecord[];
  draft: ZoneDraft | null;
  onDraft: (d: ZoneDraft | null) => void;
  onChanged: () => void;
}> = ({ site, machines, zones, draft, onDraft, onChanged }) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('restricted');
  const [target, setTarget] = useState<Target>('plant');
  const [machineKey, setMachineKey] = useState<string | null>(null);
  const [classSlug, setClassSlug] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const classes = useMemo(
    () => [...new Set(machines.map((m) => m.equipmentClassSlug).filter((c): c is string => !!c))].sort(),
    [machines],
  );

  const start = (mode: DraftMode) => {
    setError(undefined);
    onDraft({ mode, points: [], radiusM: draft?.radiusM ?? 150, widthM: draft?.widthM ?? 50 });
  };
  const chooseKind = (k: Kind) => {
    setKind(k);
    // A corridor is a path; anything else is an area. Switch the drawing tool to match.
    if (k === 'corridor') start('corridor');
    else if (draft?.mode === 'corridor') start('circle');
  };
  const chooseTarget = (tg: Target) => {
    setTarget(tg);
    if (tg === 'site-boundary') start('polygon');
  };

  const shape = draft ? draftShape(draft) : null;
  const needs = draft ? Math.max(0, MIN_POINTS[draft.mode] - draft.points.length) : 0;
  const ready = !!shape && (target === 'site-boundary' || !!name.trim())
    && (target !== 'equipment' || !!machineKey) && (target !== 'equipment-class' || !!classSlug);

  const save = async () => {
    if (!shape) return;
    setSaving(true);
    setError(undefined);
    try {
      if (target === 'site-boundary') {
        if (shape.type !== 'Polygon') throw new Error(t('geofence.draw.boundaryPolygon'));
        await apiSetPlantBoundary(site.id, shape);
      } else {
        const machine = machines.find((m) => `${m.sourceSystem}/${m.externalId}` === machineKey);
        await apiCreateGeofence({
          code: codeFrom(name), name: name.trim(), kind, shape, appliesTo: target,
          ...(target === 'plant' ? { plantId: site.id } : {}),
          ...(target === 'equipment' && machine ? { sourceSystem: machine.sourceSystem, externalId: machine.externalId } : {}),
          ...(target === 'equipment-class' && classSlug ? { equipmentClassSlug: classSlug } : {}),
        });
      }
      onDraft(null);
      setName('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : t('geofence.draw.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const targetLabel = (z: GeofenceZoneRecord) => {
    if (z.appliesTo === 'plant') return t('geofence.draw.target.plant');
    if (z.appliesTo === 'account') return t('geofence.draw.target.account');
    if (z.appliesTo === 'equipment-class') return z.equipmentClassSlug ?? '';
    const m = machines.find((x) => x.externalId === z.externalId);
    return (m?.name ?? z.externalId ?? '').split(' · ')[0];
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 space-y-3 text-sm">
        <div className="font-semibold text-slate-700 dark:text-slate-200">{t('geofence.draw.title', { site: site.name })}</div>

        {target !== 'site-boundary' && (
          <div>
            <label className={labelClass} htmlFor="zone-name">{t('geofence.draw.name')}</label>
            <input id="zone-name" className={inputClass} value={name} maxLength={80}
              placeholder={t('geofence.draw.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
            {name.trim() && <div className="mt-1 text-[11px] text-slate-400 font-mono">{t('geofence.draw.code', { code: codeFrom(name) })}</div>}
          </div>
        )}

        <div>
          <label className={labelClass} htmlFor="zone-target">{t('geofence.draw.appliesTo')}</label>
          <SelectPicker
            id="zone-target" block cleanable={false} searchable={false} value={target}
            onChange={(v) => v && chooseTarget(v as Target)}
            data={(['plant', 'equipment', 'equipment-class', 'account', 'site-boundary'] as Target[])
              .map((v) => ({ value: v, label: t(`geofence.draw.target.${v}`) }))}
          />
        </div>
        {target === 'equipment' && (
          <SelectPicker
            block placeholder={t('geofence.draw.pickMachine')} value={machineKey} onChange={setMachineKey}
            data={machines.map((m) => ({ value: `${m.sourceSystem}/${m.externalId}`, label: `${(m.name ?? m.externalId).split(' · ')[0]} · ${m.externalId}` }))}
          />
        )}
        {target === 'equipment-class' && (
          <SelectPicker
            block searchable={false} placeholder={t('geofence.draw.pickType')} value={classSlug} onChange={setClassSlug}
            data={classes.map((c) => ({ value: c, label: c }))}
          />
        )}

        {target !== 'site-boundary' && (
          <div>
            <span className={labelClass}>{t('geofence.draw.kindLabel')}</span>
            <div className="grid grid-cols-3 gap-1.5">
              {(['restricted', 'allowed', 'corridor'] as Kind[]).map((k) => (
                <button key={k} type="button" onClick={() => chooseKind(k)}
                  className={`rounded-md border px-2 py-1.5 text-xs font-medium ${kind === k
                    ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}>
                  {t(`geofence.draw.kind.${k}`)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <span className={labelClass}>{t('geofence.draw.shapeLabel')}</span>
          <div className="flex flex-wrap gap-1.5">
            {(kind === 'corridor' && target !== 'site-boundary' ? ['corridor'] : target === 'site-boundary' ? ['polygon'] : ['circle', 'polygon'])
              .map((m) => (
                <button key={m} type="button" onClick={() => start(m as DraftMode)}
                  className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium ${draft?.mode === m
                    ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}>
                  <Pencil className="w-3.5 h-3.5" />{t(`geofence.draw.mode.${m}`)}
                </button>
              ))}
          </div>
          {draft && (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {needs > 0 ? t(`geofence.draw.hint.${draft.mode}`, { count: needs }) : t('geofence.draw.hint.ready')}
            </p>
          )}
        </div>

        {draft?.mode === 'circle' && (
          <div>
            <label className={labelClass} htmlFor="zone-radius">{t('geofence.draw.radius')}</label>
            <input id="zone-radius" type="number" min={10} max={50000} step={10} className={inputClass} value={draft.radiusM}
              onChange={(e) => onDraft({ ...draft, radiusM: Math.max(1, Number(e.target.value) || 0) })} />
          </div>
        )}
        {draft?.mode === 'corridor' && (
          <div>
            <label className={labelClass} htmlFor="zone-width">{t('geofence.draw.width')}</label>
            <input id="zone-width" type="number" min={5} max={5000} step={5} className={inputClass} value={draft.widthM}
              onChange={(e) => onDraft({ ...draft, widthM: Math.max(1, Number(e.target.value) || 0) })} />
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md bg-rose-50 dark:bg-rose-950/40 px-2.5 py-2 text-xs text-rose-700 dark:text-rose-300">
            <AlertCircle className="w-4 h-4 shrink-0" />{error}
          </div>
        )}

        {draft && (
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!ready || saving} onClick={save}
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 hover:bg-sky-700 disabled:opacity-50 px-3 py-1.5 text-sm font-medium text-white">
              <Check className="w-4 h-4" />{saving ? t('geofence.draw.saving') : target === 'site-boundary' ? t('geofence.draw.saveBoundary') : t('geofence.draw.save')}
            </button>
            <button type="button" disabled={!draft.points.length} onClick={() => onDraft({ ...draft, points: draft.points.slice(0, -1) })}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-sm text-slate-600 dark:text-slate-300 disabled:opacity-50">
              <Undo2 className="w-4 h-4" />{t('geofence.draw.undo')}
            </button>
            <button type="button" onClick={() => { onDraft(null); setError(undefined); }}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-sm text-slate-600 dark:text-slate-300">
              <X className="w-4 h-4" />{t('geofence.draw.cancel')}
            </button>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 text-sm font-semibold text-slate-700 dark:text-slate-200">
          {t('geofence.draw.zonesHere', { count: zones.length })}
        </div>
        {zones.length === 0 ? (
          <p className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400">{t('geofence.draw.noZones')}</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {zones.map((z) => <ZoneRow key={z.id} zone={z} targetText={targetLabel(z)} onChanged={onChanged} />)}
          </ul>
        )}
      </div>
    </div>
  );
};

/** One zone: rename, switch on or off, delete with an in-page confirmation. */
const ZoneRow: React.FC<{ zone: GeofenceZoneRecord; targetText: string; onChanged: () => void }> = ({ zone, targetText, onChanged }) => {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(zone.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      setEditing(false);
      setConfirmDelete(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('geofence.draw.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`px-3 py-2 text-sm space-y-1.5 ${zone.enabled ? '' : 'opacity-60'}`}>
      <div className="flex items-center justify-between gap-2">
        {editing ? (
          <input aria-label={t('geofence.draw.name')} className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        ) : (
          <span className="min-w-0 truncate font-medium text-slate-700 dark:text-slate-200">{zone.name}</span>
        )}
        <Chip tone={zone.kind === 'restricted' ? 'rose' : zone.kind === 'corridor' ? 'sky' : 'emerald'}>{t(`geofence.draw.kind.${zone.kind}`)}</Chip>
      </div>
      <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
        {targetText} · <span className="font-mono">{zone.code}</span>{zone.enabled ? '' : ` · ${t('geofence.draw.off')}`}
      </div>
      {error && <div className="text-xs text-rose-600 dark:text-rose-400">{error}</div>}
      <div className="flex flex-wrap gap-1.5">
        {editing ? (
          <>
            <SmallButton disabled={busy || !name.trim()} onClick={() => run(() => apiUpdateGeofence(zone.id, { name: name.trim() }))}>{t('geofence.draw.saveName')}</SmallButton>
            <SmallButton onClick={() => { setEditing(false); setName(zone.name); }}>{t('geofence.draw.cancel')}</SmallButton>
          </>
        ) : (
          <SmallButton onClick={() => setEditing(true)}>{t('geofence.draw.rename')}</SmallButton>
        )}
        <SmallButton disabled={busy} onClick={() => run(() => apiUpdateGeofence(zone.id, { enabled: !zone.enabled }))}>
          {zone.enabled ? t('geofence.draw.switchOff') : t('geofence.draw.switchOn')}
        </SmallButton>
        {confirmDelete ? (
          <>
            <SmallButton danger disabled={busy} onClick={() => run(() => apiDeleteGeofence(zone.id))}>{t('geofence.draw.confirmDelete')}</SmallButton>
            <SmallButton onClick={() => setConfirmDelete(false)}>{t('geofence.draw.keep')}</SmallButton>
          </>
        ) : (
          <SmallButton onClick={() => setConfirmDelete(true)}><Trash2 className="w-3.5 h-3.5" />{t('geofence.draw.delete')}</SmallButton>
        )}
      </div>
    </li>
  );
};

const SmallButton: React.FC<{ onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }> = ({ onClick, disabled, danger, children }) => (
  <button type="button" onClick={onClick} disabled={disabled}
    className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs disabled:opacity-50 ${danger
      ? 'border-rose-500 bg-rose-500 text-white hover:bg-rose-600'
      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
    {children}
  </button>
);
