import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Clock3, Gauge, Plus, Wrench } from 'lucide-react';
import { CheckPicker, Input, SelectPicker } from 'rsuite';
import { useGoBack } from '../lib/useGoBack';
import { usePageHeader } from '../lib/PageHeaderContext';
import {
  ApiError, EquipmentServiceRecord, EquipmentShift, MachinePage, RecordServiceInput, RuntimeUnit, ServiceKind,
  ShiftInput, ShiftRun, Weekday, apiCreateShift, apiGetMachinePage, apiGetServiceHistory, apiGetShiftRuns,
  apiListShifts, apiReinstateShift, apiRecordService, apiRetireShift, apiUpdateShift,
} from '../lib/api';
import { Chip } from '../components/common/Chip';
import { MachineLinks } from '../components/common/MachineLinks';
import { Modal } from '../components/common/Modal';
import { Widget, GAUGE_WIDGET_TYPES } from '../components/page-widgets/PageWidgets';
import { KpiExplorer } from '../components/page-widgets/KpiExplorer';
import { ProposeKpi } from '../components/page-widgets/ProposeKpi';

// Day names are `days.0`–`days.6` (Sunday first, matching Weekday).
const DAY_OPTIONS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

function minutesToClock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function clockToMinutes(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

const RUN_STATUS_TONE: Record<string, 'emerald' | 'amber' | 'rose' | 'slate'> = {
  scored: 'emerald', 'nothing-to-score': 'slate', 'not-running': 'amber', failed: 'rose',
};

function ShiftSchedule({ sourceSystem, externalId }: { sourceSystem: string; externalId: string }) {
  const { t } = useTranslation('equipment');
  const [shifts, setShifts] = useState<EquipmentShift[]>([]);
  const [runs, setRuns] = useState<ShiftRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EquipmentShift | null>(null);

  const refresh = () => apiListShifts(sourceSystem, externalId).then(setShifts);

  useEffect(() => {
    let live = true;
    setLoading(true);
    apiGetShiftRuns(sourceSystem, externalId).then((r) => { if (live) setRuns(r); }).catch(() => {});
    apiListShifts(sourceSystem, externalId)
      .then((s) => { if (live) { setShifts(s); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('shifts.loadFailed')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSystem, externalId]);

  async function toggle(shift: EquipmentShift) {
    setBusyId(shift.id);
    try {
      if (shift.status === 'active') await apiRetireShift(sourceSystem, externalId, shift.id);
      else await apiReinstateShift(sourceSystem, externalId, shift.id);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('shifts.changeFailed'));
    } finally {
      setBusyId(null);
    }
  }

  async function create(input: ShiftInput) {
    try {
      await apiCreateShift(sourceSystem, externalId, input);
      setAdding(false);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('shifts.addFailed'));
    }
  }

  async function update(shift: EquipmentShift, input: ShiftInput) {
    try {
      await apiUpdateShift(sourceSystem, externalId, shift.id, input);
      setEditing(null);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('shifts.saveFailed'));
    }
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">{t('shifts.title')}</h3>
        <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 text-white hover:bg-sky-700 cursor-pointer">
          <Plus className="w-3.5 h-3.5" /> {t('shifts.add')}
        </button>
      </div>

      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      {loading ? (
        <p className="text-xs text-slate-400">{t('common.loading')}</p>
      ) : shifts.length === 0 ? (
        <p className="text-xs text-slate-400">{t('shifts.empty')}</p>
      ) : (
        <div className="space-y-2">
          {shifts.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{s.name}</p>
                <p className="text-[11px] text-slate-400">
                  {s.days.slice().sort().map((d) => t(`days.${d}`)).join(', ')} · {(s.endMinute - s.startMinute) % 1440 === 0
                    // 0–1440, or an end at its own start the next day, is round the clock;
                    // both printed "00:00–00:00", which read as no shift at all (MIN-14).
                    ? t('shifts.allDay', { from: minutesToClock(s.startMinute) })
                    : `${minutesToClock(s.startMinute)}–${minutesToClock(s.endMinute)}`} ({s.timeZone})
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  disabled={busyId === s.id}
                  onClick={() => setEditing(s)}
                  className="px-2 py-1 text-[11px] font-semibold rounded-md border border-slate-200 dark:border-slate-700 hover:border-sky-300 disabled:opacity-50 cursor-pointer"
                >
                  {t('common.edit')}
                </button>
                <button
                  disabled={busyId === s.id}
                  onClick={() => toggle(s)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer disabled:opacity-50 shrink-0 ${s.status === 'active' ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'}`}
                  title={s.status === 'active' ? t('shifts.retire') : t('shifts.reinstate')}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${s.status === 'active' ? 'translate-x-4.5' : 'translate-x-1'}`} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {runs.length > 0 && (
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{t('shifts.recentRuns')}</p>
          {runs.slice(0, 5).map((r) => (
            <div key={r.id} className="flex items-center justify-between text-[11px]">
              <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1"><Clock3 className="w-3 h-3" />{r.localDate} · {r.shiftName}</span>
              <Chip tone={RUN_STATUS_TONE[r.status] ?? 'slate'}>{r.detail ?? t(`runStatus.${r.status}`, { defaultValue: r.status })}</Chip>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={adding} onClose={() => setAdding(false)} title={t('shifts.add')} subtitle={t('shifts.workingHours')} maxWidth="max-w-md">
        <ShiftForm onCancel={() => setAdding(false)} onCreate={create} />
      </Modal>

      <Modal isOpen={!!editing} onClose={() => setEditing(null)} title={t('shifts.edit')} subtitle={editing?.name} maxWidth="max-w-md">
        {editing && (
          <ShiftForm key={editing.id} initial={editing} onCancel={() => setEditing(null)} onCreate={(input) => update(editing, input)} />
        )}
      </Modal>
    </div>
  );
}

const ShiftForm: React.FC<{
  /** Present when editing: the form starts from the shift's own values and saves them all. */
  initial?: EquipmentShift;
  onCancel: () => void;
  onCreate: (input: ShiftInput) => void;
}> = ({ initial, onCancel, onCreate }) => {
  const { t } = useTranslation('equipment');
  const [name, setName] = useState(initial?.name ?? '');
  const [start, setStart] = useState(initial ? minutesToClock(initial.startMinute) : '06:00');
  const [end, setEnd] = useState(initial ? minutesToClock(initial.endMinute) : '18:00');
  const [days, setDays] = useState<Weekday[]>(initial?.days ?? [1, 2, 3, 4, 5]);
  const [timeZone, setTimeZone] = useState(initial?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);

  const valid = useMemo(() => {
    const s = clockToMinutes(start);
    const e = clockToMinutes(end);
    return !!name.trim() && s != null && e != null && e > s && days.length > 0 && !!timeZone.trim();
  }, [name, start, end, days, timeZone]);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const startMinute = clockToMinutes(start);
        const endMinute = clockToMinutes(end);
        if (!valid || startMinute == null || endMinute == null) return;
        onCreate({ name: name.trim(), startMinute, endMinute, days, timeZone: timeZone.trim() });
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('shifts.name')}</span>
        <Input required value={name} onChange={(value) => setName(value)} placeholder={t('shifts.namePlaceholder')} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('shifts.start')}</span>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="w-full rounded-md border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2.5 py-1.5 text-sm" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('shifts.end')}</span>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full rounded-md border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2.5 py-1.5 text-sm" />
        </label>
      </div>
      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('shifts.days')}</span>
        <CheckPicker
          data={DAY_OPTIONS.map((d) => ({ label: t(`days.${d}`), value: d }))}
          value={days}
          onChange={(value) => setDays((value ?? []) as Weekday[])}
          block
          searchable={false}
          cleanable={false}
        />
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('shifts.timeZone')}</span>
        <Input required value={timeZone} onChange={(value) => setTimeZone(value)} placeholder={t('shifts.timeZonePlaceholder')} />
      </label>
      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer">
          {t('common.cancel')}
        </button>
        <button type="submit" disabled={!valid} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer">
          {initial ? t('common.saveChanges') : t('shifts.add')}
        </button>
      </div>
    </form>
  );
};

// Kind labels are `serviceKind.<kind>`.
const KIND_TONE: Record<ServiceKind, 'emerald' | 'amber' | 'rose' | 'slate'> = {
  scheduled: 'emerald', unscheduled: 'amber', overhaul: 'rose', 'meter-replaced': 'slate',
};
const KIND_OPTIONS: ServiceKind[] = ['scheduled', 'unscheduled', 'overhaul', 'meter-replaced'];
const UNIT_OPTIONS: RuntimeUnit[] = ['hours', 'minutes', 'seconds'];

function ServiceHistory({ sourceSystem, externalId }: { sourceSystem: string; externalId: string }) {
  const { t } = useTranslation('equipment');
  const [records, setRecords] = useState<EquipmentServiceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [recording, setRecording] = useState(false);

  const refresh = () => apiGetServiceHistory(sourceSystem, externalId).then(setRecords);

  useEffect(() => {
    let live = true;
    setLoading(true);
    apiGetServiceHistory(sourceSystem, externalId)
      .then((r) => { if (live) { setRecords(r); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('service.loadFailed')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSystem, externalId]);

  async function record(input: RecordServiceInput) {
    try {
      await apiRecordService(sourceSystem, externalId, input);
      setRecording(false);
      await refresh();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('service.recordFailed'));
    }
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">{t('service.title')}</h3>
        <button onClick={() => setRecording(true)} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 text-white hover:bg-sky-700 cursor-pointer">
          <Wrench className="w-3.5 h-3.5" /> {t('service.record')}
        </button>
      </div>

      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      {loading ? (
        <p className="text-xs text-slate-400">{t('common.loading')}</p>
      ) : records.length === 0 ? (
        <p className="text-xs text-slate-400">{t('service.empty')}</p>
      ) : (
        <div className="space-y-2">
          {records.map((r) => (
            <div key={r.id} className="flex items-start justify-between gap-2 border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                  {new Date(r.performedAt).toLocaleDateString()}
                  {r.meterReading != null && r.meterUnit && (
                    <span className="font-normal text-slate-400"> · {r.meterReading} {r.meterUnit}</span>
                  )}
                </p>
                {r.notes && <p className="text-[11px] text-slate-400 mt-0.5">{r.notes}</p>}
              </div>
              <Chip tone={KIND_TONE[r.kind]}>{t(`serviceKind.${r.kind}`, { defaultValue: r.kind })}</Chip>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={recording} onClose={() => setRecording(false)} title={t('service.record')} subtitle={t('service.title')} maxWidth="max-w-md">
        <ServiceRecordForm onCancel={() => setRecording(false)} onRecord={record} />
      </Modal>
    </div>
  );
}

const ServiceRecordForm: React.FC<{ onCancel: () => void; onRecord: (input: RecordServiceInput) => void }> = ({ onCancel, onRecord }) => {
  const { t } = useTranslation('equipment');
  const [performedAt, setPerformedAt] = useState(new Date().toISOString().slice(0, 10));
  const [kind, setKind] = useState<ServiceKind>('scheduled');
  const [meterReading, setMeterReading] = useState('');
  const [meterUnit, setMeterUnit] = useState<RuntimeUnit | null>(null);
  const [notes, setNotes] = useState('');

  const valid = useMemo(() => {
    const hasReading = meterReading.trim() !== '';
    if (hasReading !== !!meterUnit) return false;
    if (hasReading && (Number.isNaN(Number(meterReading)) || Number(meterReading) < 0)) return false;
    return !!performedAt;
  }, [meterReading, meterUnit, performedAt]);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onRecord({
          performedAt: new Date(performedAt).toISOString(),
          kind,
          meterReading: meterReading.trim() === '' ? undefined : Number(meterReading),
          meterUnit: meterUnit ?? undefined,
          notes: notes.trim() === '' ? undefined : notes.trim(),
        });
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('service.datePerformed')}</span>
        <input type="date" value={performedAt} onChange={(e) => setPerformedAt(e.target.value)} className="w-full rounded-md border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2.5 py-1.5 text-sm" />
      </label>
      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('service.kind')}</span>
        <SelectPicker
          data={KIND_OPTIONS.map((k) => ({ label: t(`serviceKind.${k}`), value: k }))}
          value={kind}
          onChange={(value) => setKind((value ?? 'scheduled') as ServiceKind)}
          block
          searchable={false}
          cleanable={false}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('service.meterReading')}</span>
          <Input value={meterReading} onChange={(value) => setMeterReading(value)} placeholder={t('service.meterReadingPlaceholder')} />
        </label>
        <div className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('service.unit')}</span>
          <SelectPicker
            data={UNIT_OPTIONS.map((u) => ({ label: t(`runtimeUnit.${u}`), value: u }))}
            value={meterUnit}
            onChange={(value) => setMeterUnit((value ?? null) as RuntimeUnit | null)}
            block
            searchable={false}
          />
        </div>
      </div>
      {meterReading.trim() !== '' !== !!meterUnit && (
        <p className="text-[11px] text-rose-500">{t('service.readingUnitPair')}</p>
      )}
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('service.notes')}</span>
        <Input as="textarea" rows={3} value={notes} onChange={(value) => setNotes(value)} placeholder={t('service.notesPlaceholder')} />
      </label>
      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer">
          {t('common.cancel')}
        </button>
        <button type="submit" disabled={!valid} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer">
          {t('service.record')}
        </button>
      </div>
    </form>
  );
};

export const EquipmentPagePage: React.FC = () => {
  const { sourceSystem, externalId } = useParams<{ sourceSystem: string; externalId: string }>();
  const navigate = useNavigate();
  const goBack = useGoBack('/admin/equipment');
  const [page, setPage] = useState<MachinePage | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  // undefined = closed; null = open on the first KPI; a key = open on that KPI.
  const [exploring, setExploring] = useState<string | null | undefined>(undefined);
  const [proposing, setProposing] = useState(false);
  // drafts: for the Propose a KPI button and modal title, which live with the drafts page.
  const { t } = useTranslation(['equipment', 'drafts']);

  usePageHeader({
    title: page?.equipment.name ?? externalId ?? t('translation:sidebar.equipment'),
    subtitle: t('equipmentPage.title'),
    onBack: goBack,
  });

  useEffect(() => {
    if (!sourceSystem || !externalId) return;
    let live = true;
    setLoading(true);
    apiGetMachinePage(sourceSystem, externalId)
      .then((result) => { if (live) { setPage(result); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('equipmentPage.loadFailed')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sourceSystem, externalId]);

  if (loading) return <p className="text-sm text-slate-500">{t('common.loading')}</p>;
  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2.5">
        <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
      </div>
    );
  }
  if (!page) return null;

  const gauges = page.widgets.filter((w) => GAUGE_WIDGET_TYPES.includes(w.widgetType));
  const lists = page.widgets.filter((w) => !gauges.includes(w));

  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-5 text-white space-y-1">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4" />
          <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">{t('equipmentPage.title')}</span>
        </div>
        <h2 className="text-lg font-bold">{page.equipment.name ?? page.equipment.externalId}</h2>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-sky-100">
            {page.equipment.sourceSystem}/{page.equipment.externalId}
            {page.equipment.classSlug ? ` · ${page.equipment.classSlug}` : ` · ${t('equipmentPage.notClassified')}`}
            {page.layout.fallback ? ` · ${t('common.fallbackLayout')}` : ''}
          </p>
          {page.equipment.classSlug && (
            <div className="flex items-center gap-2">
              <button onClick={() => setProposing(true)} className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-white/70 text-white hover:bg-white/10 cursor-pointer">
                {t('drafts:propose.button')}
              </button>
              <button onClick={() => setExploring(null)} className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-white text-sky-700 hover:bg-sky-50 cursor-pointer">
                {t('equipmentPage.exploreKpis')}
              </button>
            </div>
          )}
        </div>
        <div className="pt-2">
          <MachineLinks sourceSystem={page.equipment.sourceSystem} externalId={page.equipment.externalId} current="equipment" inverse />
        </div>
      </div>

      {page.widgets.length === 0 && (
        <p className="text-sm text-slate-400">{t('equipmentPage.noWidgets')}</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {gauges.map((w) => <Widget key={w.widgetKey} widget={w} onExploreKpi={(key) => setExploring(key)} />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {lists.map((w) => <Widget key={w.widgetKey} widget={w} />)}
      </div>

      <ShiftSchedule sourceSystem={page.equipment.sourceSystem} externalId={page.equipment.externalId} />
      <ServiceHistory sourceSystem={page.equipment.sourceSystem} externalId={page.equipment.externalId} />

      <Modal isOpen={proposing} onClose={() => setProposing(false)} title={t('drafts:propose.title')} subtitle={page.equipment.name ?? page.equipment.externalId} maxWidth="max-w-xl">
        {proposing && page.equipment.classSlug && (
          <ProposeKpi sourceSystem={page.equipment.sourceSystem} externalId={page.equipment.externalId} classSlug={page.equipment.classSlug} />
        )}
      </Modal>

      <Modal isOpen={exploring !== undefined} onClose={() => setExploring(undefined)} title={t('kpiExplorer.title')} subtitle={page.equipment.name ?? page.equipment.externalId} maxWidth="max-w-2xl">
        {exploring !== undefined && (
          <KpiExplorer
            key={exploring ?? 'first'}
            sourceSystem={page.equipment.sourceSystem}
            externalId={page.equipment.externalId}
            initialFormulaKey={exploring ?? undefined}
          />
        )}
      </Modal>
    </div>
  );
};
