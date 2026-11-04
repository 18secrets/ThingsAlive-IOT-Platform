import React from 'react';
import { severityTone, statusTone } from '../components/common/statusTone';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Activity, Bell, ClipboardList, Fuel, Gauge, Plus, ShieldCheck, Wrench } from 'lucide-react';
import { useGoBack } from '../lib/useGoBack';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Slot, useSlot } from '../lib/useSlot';
import { Chip } from '../components/common/Chip';
import { RingGauge } from '../components/common/RingGauge';
import { MachineLinks } from '../components/common/MachineLinks';
import {
  AlertEvent, EffectiveParameter, EquipmentAvailability, EquipmentOee, EquipmentProfile, FleetLinkRow, MachineShiftFuel, Plant,
  Prediction, ShieldSummary, ShiftFuelRow, WorkOrder,
  apiGetDeviceHealthFleet, apiGetEffectiveParameters, apiGetEquipmentAvailability, apiGetEquipmentOee, apiGetLatestPredictions,
  apiGetMachineShiftFuel,
  apiGetShieldSummary, apiListAlerts, apiListEquipment, apiListPlants, apiListWorkOrders,
} from '../lib/api';
import { PanelRow, PanelRows, shortWhen } from '../components/common/PanelRow';

const DAY = 86_400_000;
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);

const SEVERITY_TONE = (s: string) => severityTone(s, { noneIsHealthy: true });

/**
 * One machine at a glance, from live data (the live dashboard's drill-down): status,
 * this week's OEE and availability, predictions, open alerts and jobs, its compliance
 * status and the cost parameters that apply to it. Each block comes from the page that
 * owns it and links there.
 */
export const ThingDetailLivePage: React.FC = () => {
  const { sourceSystem = '', externalId = '' } = useParams<{ sourceSystem: string; externalId: string }>();
  const navigate = useNavigate();
  const goBack = useGoBack('/dashboard');
  const { t } = useTranslation('dashboard');
  const key = [sourceSystem, externalId];

  const profile = useSlot<EquipmentProfile | null>(
    () => apiListEquipment().then((l) => l.find((e) => e.sourceSystem === sourceSystem && e.externalId === externalId) ?? null), key);
  const plants = useSlot<Plant[]>(() => apiListPlants(), []);
  const link = useSlot<FleetLinkRow | null>(
    () => apiGetDeviceHealthFleet({ days: 7 }).then((rows) => rows.find((r) => r.externalId === externalId) ?? null), key);
  const oee = useSlot<EquipmentOee>(() => apiGetEquipmentOee(sourceSystem, externalId, 'week'), key);
  const availability = useSlot<EquipmentAvailability>(
    () => apiGetEquipmentAvailability(sourceSystem, externalId, new Date(Date.now() - 7 * DAY).toISOString(), new Date().toISOString()), key);
  const predictions = useSlot<Prediction[]>(() => apiGetLatestPredictions(sourceSystem, externalId), key);
  const alerts = useSlot<AlertEvent[]>(() => apiListAlerts({ state: ['open', 'acknowledged'], equipment: externalId }), key);
  const orders = useSlot<WorkOrder[]>(() => apiListWorkOrders({ status: ['created', 'in-progress'], equipment: externalId }), key);
  const shield = useSlot<ShieldSummary>(() => apiGetShieldSummary(), key);
  // The last three days: yesterday's shifts to score against, today's and the next to come.
  const fuel = useSlot<MachineShiftFuel>(() => apiGetMachineShiftFuel(sourceSystem, externalId, 3), key);
  // Parameters resolve per machine by its register id, which only the profile carries.
  // While the profile loads this stays pending — rejecting flashed "not available for
  // your role", which is what any rejection renders as, before the real answer arrived.
  const params = useSlot<EffectiveParameter[]>(
    () => (profile.state === 'loading' ? new Promise<never>(() => {})
      : profile.state === 'ok' && profile.data ? apiGetEffectiveParameters({ scope: 'equipment', scopeRef: profile.data.id })
      : Promise.reject(new Error('no profile'))),
    [profile.state],
  );

  // Not the bare code while the profile loads: it flashed in the title before the name
  // replaced it (test report COS-6). The code stays the fallback for a machine with no name.
  const name = profile.state === 'loading' ? t('common.loading')
    : profile.state === 'ok' && profile.data ? profile.data.name ?? externalId : externalId;
  usePageHeader({ breadcrumb: t('translation:sidebar.dashboard'), title: name, subtitle: t('thingLive.subtitle'), onBack: goBack });

  if (profile.state === 'ok' && !profile.data) {
    return <p className="text-sm text-slate-500">{t('thingLive.notInRegister')}</p>;
  }

  const p = profile.state === 'ok' ? profile.data : null;
  const siteName = p?.plantId && plants.state === 'ok' ? plants.data.find((x) => x.id === p.plantId)?.name : undefined;
  const shieldCells = shield.state === 'ok'
    ? shield.data.machines.find((m) => m.machine.sourceSystem === sourceSystem && m.machine.externalId === externalId)?.categories
    : undefined;

  return (
    <div className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">{t('thingLive.banner')}</span>
        <h2 className="text-xl font-bold">{profile.state === 'loading' ? '…' : name}</h2>
        <p className="text-xs text-sky-100">
          {/* "not classified" only once the register has answered; before, it is just unknown (COS-6). */}
          {sourceSystem}/{externalId}{p?.equipmentClassSlug ? ` · ${p.equipmentClassSlug}` : profile.state === 'ok' ? ` · ${t('thingLive.notClassified')}` : ''}{siteName ? ` · ${siteName}` : ''}
        </p>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex items-center gap-5 flex-wrap">
        <span title={t('thingLive.oeeCalendarWeek')}>
          <RingGauge value={oee.state === 'ok' && oee.data.oee.value != null ? oee.data.oee.value * 100 : null} size={72} colorClass="text-emerald-500 dark:text-emerald-400" />
        </span>
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center gap-1.5 flex-wrap">
            {link.state === 'ok' && (link.data
              ? <Chip tone={link.data.state === 'dark' ? 'rose' : link.data.state === 'healthy' ? 'emerald' : 'amber'}>{link.data.state === 'dark' ? t('linkState.dark') : t('thingLive.onlineState', { state: t(`linkState.${link.data.state}`, { defaultValue: link.data.state }) })}</Chip>
              : <Chip tone="slate">{t('thingLive.noLoggerHealth')}</Chip>)}
            <Chip tone="slate">{t('thingLive.oeeThisWeek', { value: oee.state === 'ok' && oee.data.oee.readiness === 'ready' ? pct(oee.data.oee.value) : '—' })}</Chip>
            <Chip tone="slate">
              {t('thingLive.availability7d', { value: availability.state === 'ok' && availability.data.availability != null ? `${(availability.data.availability * 100).toFixed(0)}%` : '—' })}
            </Chip>
          </div>
          {oee.state === 'ok' && oee.data.oee.readiness !== 'ready' && (
            <p className="text-slate-400">{t('thingLive.oeeUnavailable', { reason: oee.data.oee.reason ? t(`thingLive.oeeReason.${oee.data.oee.reason}`, { defaultValue: oee.data.oee.reason }) : oee.data.oee.readiness })}</p>
          )}
          <div className="pt-1">
            <MachineLinks sourceSystem={sourceSystem} externalId={externalId} current="detail" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title={t('thingLive.predictions')} icon={<Activity className="w-4 h-4" />} slot={predictions} empty={t('thingLive.predictionsEmpty')}
          render={(d) => d.map((x) => (
            <PanelRow key={x.id} title={x.clientScenarioSlug}
              detail={t('thingLive.risk', { score: x.riskScore, confidence: t(`confidence.${x.confidence}`, { defaultValue: x.confidence }) })}
              right={<Chip tone={SEVERITY_TONE(x.severity) ?? 'slate'}>{t(`severity.${x.severity}`, { defaultValue: x.severity })}</Chip>} />
          ))} />
        <Panel title={t('thingLive.openAlerts')} icon={<Bell className="w-4 h-4" />} slot={alerts} empty={t('thingLive.openAlertsEmpty')}
          render={(d) => d.map((a) => (
            <PanelRow key={a.id} title={a.ruleName} detail={a.summary}
              meta={`${t(`state.${a.state}`, { defaultValue: a.state })} · ${shortWhen(a.firedAt)}`}
              right={<Chip tone={SEVERITY_TONE(a.severity) ?? 'slate'}>{t(`severity.${a.severity}`, { defaultValue: a.severity })}</Chip>} />
          ))} />
      </div>

      {/* Work, compliance and this week's OEE down the left; the long cost list down the right,
          beside all three rather than stretching one card to its height. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="flex flex-col gap-3">
          <Panel title={t('thingLive.openWorkOrders')} icon={<ClipboardList className="w-4 h-4" />} slot={orders} empty={t('thingLive.openWorkOrdersEmpty')}
            action={<button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline cursor-pointer"><Plus className="w-3.5 h-3.5" /> {t('thingLive.create')}</button>}
            render={(d) => d.map((o) => (
              <PanelRow key={o.id} title={o.title}
                detail={`${o.reference} · ${t(`priority.${o.priority}`, { defaultValue: o.priority })}${o.dueAt ? ` · ${t('thingLive.due', { date: new Date(o.dueAt).toLocaleDateString() })}` : ''}`}
                right={<Chip tone={statusTone(o.status)}>{t(`workOrderStatus.${o.status}`, { defaultValue: o.status })}</Chip>} />
            ))} />
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100"><ShieldCheck className="w-4 h-4" />{t('thingLive.compliance')}</p>
            {shield.state === 'loading' ? <Muted>{t('common.loading')}</Muted> : !shieldCells ? <Muted>{t('common.unavailable')}</Muted> : (
              <div className="flex gap-1.5 flex-wrap">
                {(['compliance', 'safety', 'security'] as const).map((c) => (
                  <Chip key={c} tone={{ current: 'emerald', due_soon: 'amber', overdue: 'rose', action_required: 'rose', not_recorded: 'slate' }[shieldCells[c].status] as 'emerald'}>
                    {t('thingLive.shieldCell', { category: t(`shieldCategory.${c}`), status: t(`shieldStatus.${shieldCells[c].status}`, { defaultValue: shieldCells[c].status.replace('_', ' ') }) })}
                  </Chip>
                ))}
              </div>
            )}
          </div>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100"><Gauge className="w-4 h-4" />{t('thingLive.thisWeekOee')}</p>
            {oee.state !== 'ok' ? <Muted>{oee.state === 'loading' ? t('common.loading') : t('common.unavailable')}</Muted> : (
              <div className="grid grid-cols-3 gap-2 text-xs">
                {([[t('common.availability'), oee.data.availability], [t('common.performance'), oee.data.performance], [t('common.quality'), oee.data.quality]] as const).map(([label, f]) => (
                  <div key={label} className="border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
                    <p className="text-xs text-slate-400">{label}</p>
                    <p className="text-lg font-bold font-mono text-slate-800 dark:text-slate-100">{f.readiness === 'ready' ? pct(f.value) : '—'}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
          <FuelPerShift slot={fuel} />
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100"><Wrench className="w-4 h-4" />{t('thingLive.costParams')}</p>
          {params.state === 'loading' ? <Muted>{t('common.loading')}</Muted> : params.state === 'unavailable' ? <Muted>{t('common.unavailable')}</Muted> : (
            <PanelRows>
              {/* Cost units are stored as "currency/L"; the account's currency is itself a parameter. */}
              {params.data.map((x) => (
                <PanelRow key={x.name} title={x.name.replace(/_/g, ' ')}
                  detail={x.source && x.value != null ? t(`paramScope.${x.source.scope}`, { defaultValue: x.source.scope }) : t('thingLive.notSet')}
                  right={x.source && x.value != null
                    ? <span className="font-mono text-sm text-slate-700 dark:text-slate-200">{String(x.value)}{x.unit && x.name !== 'currency' ? ` ${x.unit.replace(/currency/g, String(params.data.find((c) => c.name === 'currency')?.value ?? 'currency'))}` : ''}</span>
                    : <span className="text-slate-400">—</span>} />
              ))}
            </PanelRows>
          )}
        </div>
      </div>
    </div>
  );
};

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => <p className="text-xs text-slate-400">{children}</p>;

const litres = (l: number) => l.toFixed(1);
/** "2026-11-03" read as that calendar day, not as UTC midnight shifted into the reader's zone. */
const shiftDate = (sdate: string) => {
  const [y, m, d] = sdate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
/** The accuracy page's score for one shift (D53): 100 − the miss as a share of what burned, never below 0. */
const shiftAccuracy = (forecast: number, actual: number) => Math.max(0, 100 - Math.round((100 * Math.abs(forecast - actual)) / actual));

/**
 * Fuel per shift (D50, D52): the forecast where people look at the machine, not only on the
 * accuracy page (fuel test report TC-FP-11). The shift under way shows its in-shift
 * re-forecast; each recent shift its forecast, and once the existing platform has totalled
 * it, what burned and how close the forecast came. A forecast learned from no history is
 * said to be one rather than shown as a bare "0 L" (TC-FP-09).
 */
const FuelPerShift: React.FC<{ slot: Slot<MachineShiftFuel> }> = ({ slot }) => {
  const { t } = useTranslation('dashboard');
  const now = Date.now();
  const rows = slot.state === 'ok' ? [...slot.data.shifts].reverse().slice(0, 4) : [];
  const nowcast = slot.state === 'ok' ? slot.data.nowcast : null;
  const any = nowcast != null || rows.some((r) => r.predictedL != null || r.fuelL != null);

  const label = (r: { sdate: string; shift: 1 | 2 }) => t('thingLive.fuel.shiftLabel', { n: r.shift, date: shiftDate(r.sdate) });
  const detail = (r: ShiftFuelRow) => {
    const forecast = r.predictedL == null ? t('thingLive.fuel.noForecast')
      : r.inputsThrough == null && r.predictedL === 0 ? t('thingLive.fuel.noHistory')
        : t('thingLive.fuel.forecast', { litres: litres(r.predictedL) });
    const ended = Date.parse(r.endsAt) <= now;
    const actual = r.fuelL != null
      ? t('thingLive.fuel.actual', { litres: litres(r.fuelL), hours: (r.workHrs ?? 0).toFixed(1) })
      : ended ? t('thingLive.fuel.notTotalled') : null;
    return actual ? `${forecast} · ${actual}` : forecast;
  };
  const right = (r: ShiftFuelRow) => {
    if (Date.parse(r.startsAt) > now) return <Chip tone="slate">{t('thingLive.fuel.next')}</Chip>;
    if (Date.parse(r.endsAt) > now) return <Chip tone="sky">{t('thingLive.fuel.running')}</Chip>;
    if (r.predictedL == null || r.fuelL == null || r.fuelL <= 0) return undefined;
    const a = shiftAccuracy(r.predictedL, r.fuelL);
    return <Chip tone={a >= 85 ? 'emerald' : a >= 70 ? 'amber' : 'rose'}>{t('thingLive.fuel.accuracy', { pct: a })}</Chip>;
  };
  // A counter last read well before the snapshot means the feed went quiet: say when it last spoke.
  const stale = nowcast != null && Date.parse(nowcast.asOf) - Date.parse(nowcast.counterAt) > 30 * 60_000;

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100"><Fuel className="w-4 h-4" />{t('thingLive.fuel.title')}</p>
      {slot.state === 'loading' ? <Muted>{t('common.loading')}</Muted>
        : slot.state === 'unavailable' ? <Muted>{t('common.unavailable')}</Muted>
          : !any ? <Muted>{t('thingLive.fuel.none')}</Muted> : (
            <>
              {nowcast && (
                <div className="rounded-lg border border-sky-100 dark:border-sky-900 bg-sky-50/60 dark:bg-sky-950/30 p-3 text-xs space-y-0.5">
                  <p className="text-slate-500 dark:text-slate-400">{t('thingLive.fuel.nowTitle', { shift: label(nowcast) })}</p>
                  <p className="text-lg font-bold font-mono text-slate-800 dark:text-slate-100">{litres(nowcast.predictedL)} L</p>
                  <p className="text-slate-600 dark:text-slate-300">
                    {t('thingLive.fuel.nowDetail', { soFar: litres(nowcast.soFarL), rest: litres(Math.max(0, nowcast.predictedL - nowcast.soFarL)) })}
                  </p>
                  <p className="text-slate-500">
                    {t('thingLive.fuel.asOf', { time: shortWhen(nowcast.asOf) })}
                    {stale ? ` · ${t('thingLive.fuel.stale', { time: shortWhen(nowcast.counterAt) })}` : ''}
                  </p>
                </div>
              )}
              <PanelRows>
                {rows.map((r) => <PanelRow key={`${r.sdate}-${r.shift}`} title={label(r)} detail={detail(r)} right={right(r)} />)}
              </PanelRows>
              <p className="text-xs text-slate-500">{t('thingLive.fuel.method')}</p>
            </>
          )}
    </div>
  );
};

function Panel<T>({ title, icon, slot, empty, render, action }: {
  title: string; icon: React.ReactNode; slot: Slot<T[]>; empty: string; render: (d: T[]) => React.ReactNode; action?: React.ReactNode;
}) {
  const { t } = useTranslation('dashboard');
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">{icon}{title}</p>
        {action}
      </div>
      {slot.state === 'loading' ? <Muted>{t('common.loading')}</Muted>
        : slot.state === 'unavailable' ? <Muted>{t('common.unavailable')}</Muted>
          : slot.data.length === 0 ? <Muted>{empty}</Muted>
            : <PanelRows>{render(slot.data)}</PanelRows>}
    </div>
  );
}
