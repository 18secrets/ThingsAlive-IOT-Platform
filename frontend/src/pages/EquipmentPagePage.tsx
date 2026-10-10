import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Clock3, Gauge, Plus, Wrench } from 'lucide-react';
import { CheckPicker, Input, SelectPicker } from 'rsuite';
import { usePageHeader } from '../lib/PageHeaderContext';
import {
  ApiError, EquipmentServiceRecord, EquipmentShift, MachinePage, RecordServiceInput, RuntimeUnit, ServiceKind,
  ShiftInput, ShiftRun, Weekday, apiCreateShift, apiGetMachinePage, apiGetServiceHistory, apiGetShiftRuns,
  apiListShifts, apiReinstateShift, apiRecordService, apiRetireShift,
} from '../lib/api';
import { Chip } from '../components/common/Chip';
import { Modal } from '../components/common/Modal';
import { Widget, GAUGE_WIDGET_TYPES } from '../components/page-widgets/PageWidgets';

const DAY_LABEL: Record<Weekday, string> = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };
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
  const [shifts, setShifts] = useState<EquipmentShift[]>([]);
  const [runs, setRuns] = useState<ShiftRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = () => apiListShifts(sourceSystem, externalId).then(setShifts);

  useEffect(() => {
    let live = true;
    setLoading(true);
    apiGetShiftRuns(sourceSystem, externalId).then((r) => { if (live) setRuns(r); }).catch(() => {});
    apiListShifts(sourceSystem, externalId)
      .then((s) => { if (live) { setShifts(s); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load the shift schedule.'); })
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
      window.alert(err instanceof ApiError ? err.message : 'Could not change this shift.');
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
      window.alert(err instanceof ApiError ? err.message : 'Could not add this shift.');
    }
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Shift schedule</h3>
        <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 text-white hover:bg-sky-700 cursor-pointer">
          <Plus className="w-3.5 h-3.5" /> Add shift
        </button>
      </div>

      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      {loading ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : shifts.length === 0 ? (
        <p className="text-xs text-slate-400">No shifts configured. Utilization and availability stay "not_configured" until one exists.</p>
      ) : (
        <div className="space-y-2">
          {shifts.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{s.name}</p>
                <p className="text-[11px] text-slate-400">
                  {s.days.slice().sort().map((d) => DAY_LABEL[d]).join(', ')} · {minutesToClock(s.startMinute)}–{minutesToClock(s.endMinute)} ({s.timeZone})
                </p>
              </div>
              <button
                disabled={busyId === s.id}
                onClick={() => toggle(s)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer disabled:opacity-50 shrink-0 ${s.status === 'active' ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'}`}
                title={s.status === 'active' ? 'Retire' : 'Reinstate'}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${s.status === 'active' ? 'translate-x-4.5' : 'translate-x-1'}`} />
              </button>
            </div>
          ))}
        </div>
      )}

      {runs.length > 0 && (
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Recent shift runs</p>
          {runs.slice(0, 5).map((r) => (
            <div key={r.id} className="flex items-center justify-between text-[11px]">
              <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1"><Clock3 className="w-3 h-3" />{r.localDate} · {r.shiftName}</span>
              <Chip tone={RUN_STATUS_TONE[r.status] ?? 'slate'}>{r.detail ?? r.status}</Chip>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={adding} onClose={() => setAdding(false)} title="Add shift" subtitle="Working Hours" maxWidth="max-w-md">
        <ShiftForm onCancel={() => setAdding(false)} onCreate={create} />
      </Modal>
    </div>
  );
}

const ShiftForm: React.FC<{ onCancel: () => void; onCreate: (input: ShiftInput) => void }> = ({ onCancel, onCreate }) => {
  const [name, setName] = useState('');
  const [start, setStart] = useState('06:00');
  const [end, setEnd] = useState('18:00');
  const [days, setDays] = useState<Weekday[]>([1, 2, 3, 4, 5]);
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);

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
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Name</span>
        <Input required value={name} onChange={(value) => setName(value)} placeholder="e.g. Day shift" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Start (HH:MM)</span>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="w-full rounded-md border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2.5 py-1.5 text-sm" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">End (HH:MM)</span>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full rounded-md border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2.5 py-1.5 text-sm" />
        </label>
      </div>
      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Days</span>
        <CheckPicker
          data={DAY_OPTIONS.map((d) => ({ label: DAY_LABEL[d], value: d }))}
          value={days}
          onChange={(value) => setDays((value ?? []) as Weekday[])}
          block
          searchable={false}
          cleanable={false}
        />
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Time zone (IANA)</span>
        <Input required value={timeZone} onChange={(value) => setTimeZone(value)} placeholder="e.g. Asia/Kolkata" />
      </label>
      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer">
          Cancel
        </button>
        <button type="submit" disabled={!valid} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer">
          Add shift
        </button>
      </div>
    </form>
  );
};

const KIND_LABEL: Record<ServiceKind, string> = {
  scheduled: 'Scheduled', unscheduled: 'Unscheduled', overhaul: 'Overhaul', 'meter-replaced': 'Meter replaced',
};
const KIND_TONE: Record<ServiceKind, 'emerald' | 'amber' | 'rose' | 'slate'> = {
  scheduled: 'emerald', unscheduled: 'amber', overhaul: 'rose', 'meter-replaced': 'slate',
};
const KIND_OPTIONS: ServiceKind[] = ['scheduled', 'unscheduled', 'overhaul', 'meter-replaced'];
const UNIT_OPTIONS: RuntimeUnit[] = ['hours', 'minutes', 'seconds'];

function ServiceHistory({ sourceSystem, externalId }: { sourceSystem: string; externalId: string }) {
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
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load the service history.'); })
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
      window.alert(err instanceof ApiError ? err.message : 'Could not record this service.');
    }
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Service history</h3>
        <button onClick={() => setRecording(true)} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 text-white hover:bg-sky-700 cursor-pointer">
          <Wrench className="w-3.5 h-3.5" /> Record service
        </button>
      </div>

      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      {loading ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : records.length === 0 ? (
        <p className="text-xs text-slate-400">No service recorded yet. The forecast above falls back to commissioning as its datum until one is.</p>
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
              <Chip tone={KIND_TONE[r.kind]}>{KIND_LABEL[r.kind]}</Chip>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={recording} onClose={() => setRecording(false)} title="Record service" subtitle="Service history" maxWidth="max-w-md">
        <ServiceRecordForm onCancel={() => setRecording(false)} onRecord={record} />
      </Modal>
    </div>
  );
}

const ServiceRecordForm: React.FC<{ onCancel: () => void; onRecord: (input: RecordServiceInput) => void }> = ({ onCancel, onRecord }) => {
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
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Date performed</span>
        <input type="date" value={performedAt} onChange={(e) => setPerformedAt(e.target.value)} className="w-full rounded-md border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2.5 py-1.5 text-sm" />
      </label>
      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Kind</span>
        <SelectPicker
          data={KIND_OPTIONS.map((k) => ({ label: KIND_LABEL[k], value: k }))}
          value={kind}
          onChange={(value) => setKind((value ?? 'scheduled') as ServiceKind)}
          block
          searchable={false}
          cleanable={false}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Meter reading</span>
          <Input value={meterReading} onChange={(value) => setMeterReading(value)} placeholder="e.g. 1420" />
        </label>
        <div className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Unit</span>
          <SelectPicker
            data={UNIT_OPTIONS.map((u) => ({ label: u, value: u }))}
            value={meterUnit}
            onChange={(value) => setMeterUnit((value ?? null) as RuntimeUnit | null)}
            block
            searchable={false}
          />
        </div>
      </div>
      {meterReading.trim() !== '' !== !!meterUnit && (
        <p className="text-[11px] text-rose-500">A meter reading needs its unit, and a unit needs a reading.</p>
      )}
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Notes</span>
        <Input as="textarea" rows={3} value={notes} onChange={(value) => setNotes(value)} placeholder="What was done" />
      </label>
      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer">
          Cancel
        </button>
        <button type="submit" disabled={!valid} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer">
          Record service
        </button>
      </div>
    </form>
  );
};

export const EquipmentPagePage: React.FC = () => {
  const { sourceSystem, externalId } = useParams<{ sourceSystem: string; externalId: string }>();
  const navigate = useNavigate();
  const [page, setPage] = useState<MachinePage | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  usePageHeader({
    title: page?.equipment.name ?? externalId ?? 'Equipment',
    subtitle: 'Equipment page',
    onBack: () => navigate('/admin/equipment'),
  });

  useEffect(() => {
    if (!sourceSystem || !externalId) return;
    let live = true;
    setLoading(true);
    apiGetMachinePage(sourceSystem, externalId)
      .then((result) => { if (live) { setPage(result); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load this equipment page.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sourceSystem, externalId]);

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;
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
          <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">Equipment page</span>
        </div>
        <h2 className="text-lg font-bold">{page.equipment.name ?? page.equipment.externalId}</h2>
        <p className="text-xs text-sky-100">
          {page.equipment.sourceSystem}/{page.equipment.externalId}
          {page.equipment.classSlug ? ` · ${page.equipment.classSlug}` : ' · Not classified'}
          {page.layout.fallback ? ' · fallback layout' : ''}
        </p>
      </div>

      {page.widgets.length === 0 && (
        <p className="text-sm text-slate-400">No widgets configured for this equipment's class yet.</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {gauges.map((w) => <Widget key={w.widgetKey} widget={w} />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {lists.map((w) => <Widget key={w.widgetKey} widget={w} />)}
      </div>

      <ShiftSchedule sourceSystem={page.equipment.sourceSystem} externalId={page.equipment.externalId} />
      <ServiceHistory sourceSystem={page.equipment.sourceSystem} externalId={page.equipment.externalId} />
    </div>
  );
};
