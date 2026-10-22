import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Activity, Bell, ClipboardList, Gauge, Plus, ShieldCheck, Wrench } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Slot, useSlot } from '../lib/useSlot';
import { Chip } from '../components/common/Chip';
import { RingGauge } from '../components/common/RingGauge';
import { MachineLinks } from '../components/common/MachineLinks';
import {
  AlertEvent, EffectiveParameter, EquipmentAvailability, EquipmentOee, EquipmentProfile, FleetLinkRow, Plant, Prediction,
  ShieldSummary, WorkOrder,
  apiGetDeviceHealthFleet, apiGetEffectiveParameters, apiGetEquipmentAvailability, apiGetEquipmentOee, apiGetLatestPredictions,
  apiGetShieldSummary, apiListAlerts, apiListEquipment, apiListPlants, apiListWorkOrders,
} from '../lib/api';

const DAY = 86_400_000;
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);

const SEVERITY_TONE: Record<string, 'rose' | 'amber' | 'sky' | 'emerald' | 'slate'> = {
  critical: 'rose', high: 'rose', medium: 'amber', low: 'sky', none: 'emerald',
};

/**
 * One machine at a glance, from live data (the live dashboard's drill-down): status,
 * this week's OEE and availability, predictions, open alerts and jobs, its compliance
 * status and the cost parameters that apply to it. Each block comes from the page that
 * owns it and links there.
 */
export const ThingDetailLivePage: React.FC = () => {
  const { sourceSystem = '', externalId = '' } = useParams<{ sourceSystem: string; externalId: string }>();
  const navigate = useNavigate();
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
  // Parameters resolve per machine by its register id, which only the profile carries.
  const params = useSlot<EffectiveParameter[]>(
    () => (profile.state === 'ok' && profile.data ? apiGetEffectiveParameters({ scope: 'equipment', scopeRef: profile.data.id }) : Promise.reject(new Error('no profile'))),
    [profile.state],
  );

  const name = profile.state === 'ok' && profile.data ? profile.data.name ?? externalId : externalId;
  usePageHeader({ title: name, subtitle: t('thingLive.subtitle'), onBack: () => navigate('/dashboard') });

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
        <h2 className="text-xl font-bold">{name}</h2>
        <p className="text-xs text-sky-100">
          {sourceSystem}/{externalId}{p?.equipmentClassSlug ? ` · ${p.equipmentClassSlug}` : ` · ${t('thingLive.notClassified')}`}{siteName ? ` · ${siteName}` : ''}
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
              {t('thingLive.availability7d', { value: availability.state === 'ok' && availability.data.availability != null ? `${availability.data.availability.toFixed(0)}%` : '—' })}
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
            <Row key={x.id} left={x.clientScenarioSlug}
              right={<><Chip tone={SEVERITY_TONE[x.severity] ?? 'slate'}>{t(`severity.${x.severity}`, { defaultValue: x.severity })}</Chip><span className="text-slate-400">{t('thingLive.risk', { score: x.riskScore, confidence: t(`confidence.${x.confidence}`, { defaultValue: x.confidence }) })}</span></>} />
          ))} />
        <Panel title={t('thingLive.openAlerts')} icon={<Bell className="w-4 h-4" />} slot={alerts} empty={t('thingLive.openAlertsEmpty')}
          render={(d) => d.map((a) => (
            <Row key={a.id} left={a.summary} right={<><Chip tone={SEVERITY_TONE[a.severity] ?? 'slate'}>{t(`severity.${a.severity}`, { defaultValue: a.severity })}</Chip><span className="text-slate-400">{t(`state.${a.state}`, { defaultValue: a.state })}</span></>} />
          ))} />
        <Panel title={t('thingLive.openWorkOrders')} icon={<ClipboardList className="w-4 h-4" />} slot={orders} empty={t('thingLive.openWorkOrdersEmpty')}
          action={<button onClick={() => navigate('/work-orders')} className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline cursor-pointer"><Plus className="w-3.5 h-3.5" /> {t('thingLive.create')}</button>}
          render={(d) => d.map((o) => (
            <Row key={o.id} left={`${o.reference} · ${o.title}`} right={<span className="text-slate-400">{t(`workOrderStatus.${o.status}`, { defaultValue: o.status })} · {t(`priority.${o.priority}`, { defaultValue: o.priority })}{o.dueAt ? ` · ${t('thingLive.due', { date: new Date(o.dueAt).toLocaleDateString() })}` : ''}</span>} />
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
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100"><Gauge className="w-4 h-4" />{t('thingLive.thisWeekOee')}</p>
          {oee.state !== 'ok' ? <Muted>{oee.state === 'loading' ? t('common.loading') : t('common.unavailable')}</Muted> : (
            <div className="grid grid-cols-3 gap-2 text-xs">
              {([[t('common.availability'), oee.data.availability], [t('common.performance'), oee.data.performance], [t('common.quality'), oee.data.quality]] as const).map(([label, f]) => (
                <div key={label} className="border border-slate-100 dark:border-slate-800 rounded-lg p-2.5">
                  <p className="text-[11px] text-slate-400">{label}</p>
                  <p className="text-lg font-bold font-mono text-slate-800 dark:text-slate-100">{f.readiness === 'ready' ? pct(f.value) : '—'}</p>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100"><Wrench className="w-4 h-4" />{t('thingLive.costParams')}</p>
          {params.state === 'loading' ? <Muted>{t('common.loading')}</Muted> : params.state === 'unavailable' ? <Muted>{t('common.unavailable')}</Muted> : (
            <div className="space-y-1">
              {/* Cost units are stored as "currency/L"; the account's currency is itself a parameter. */}
              {params.data.map((x) => (
                <Row key={x.name} left={x.name.replace(/_/g, ' ')}
                  right={x.source && x.value != null
                    ? <><span className="font-mono text-slate-700 dark:text-slate-200">{String(x.value)}{x.unit && x.name !== 'currency' ? ` ${x.unit.replace(/currency/g, String(params.data.find((c) => c.name === 'currency')?.value ?? 'currency'))}` : ''}</span><Chip tone="slate">{t(`paramScope.${x.source.scope}`, { defaultValue: x.source.scope })}</Chip></>
                    : <span className="text-slate-400">{t('thingLive.notSet')}</span>} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => <p className="text-xs text-slate-400">{children}</p>;

const Row: React.FC<{ left: string; right: React.ReactNode }> = ({ left, right }) => (
  <div className="flex items-center justify-between gap-2 text-xs border-t border-slate-100 dark:border-slate-800 pt-1.5">
    <span className="text-slate-700 dark:text-slate-200 truncate">{left}</span>
    <span className="flex items-center gap-1.5 shrink-0">{right}</span>
  </div>
);

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
            : <div className="space-y-1">{render(slot.data)}</div>}
    </div>
  );
}
