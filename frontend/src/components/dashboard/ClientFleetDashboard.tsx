import React, { useMemo } from 'react';
import { Boxes, Radio, AlertTriangle, Layers, ExternalLink } from 'lucide-react';
import { EquipmentTemplate, Sensor } from '../../lib/api';
import { TemplateAlertRule } from '../../types';

interface ClientFleetDashboardProps {
  masterTemplates: EquipmentTemplate[];
  myTemplates: EquipmentTemplate[];
  templateSensorLinks: Record<string, string[]>;
  myTemplateSensorLinks: Record<string, string[]>;
  alertRules: TemplateAlertRule[];
  myAlertRules: TemplateAlertRule[];
  allSensors: Sensor[];
  /** Only ever called for the client's own templates — Master Library cards aren't clickable. */
  onOpenTemplate: (templateId: string) => void;
}

/** Small deterministic hash so a template's dummy stats stay stable across renders
 *  and reloads instead of jumping around every time — real numbers, once this
 *  screen has a backend, replace the seeded ones without changing the layout. */
function seedHash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) h = (h * 31 + input.charCodeAt(i)) >>> 0;
  return h;
}
function seededInt(seed: string, min: number, max: number): number {
  return min + (seedHash(seed) % (max - min + 1));
}

const TIER_STYLE: Record<string, string> = {
  T0: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  T1: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800',
  T2: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
};

export const ClientFleetDashboard: React.FC<ClientFleetDashboardProps> = ({
  masterTemplates, myTemplates, templateSensorLinks, myTemplateSensorLinks,
  alertRules, myAlertRules, allSensors, onOpenTemplate,
}) => {
  const classes = useMemo(() => {
    const fromMaster = masterTemplates.map((t) => ({ template: t, mine: false }));
    const fromMine = myTemplates.map((t) => ({ template: t, mine: true }));
    return [...fromMaster, ...fromMine].map(({ template: t, mine }) => {
      const attachedIds = (mine ? myTemplateSensorLinks : templateSensorLinks)[t.id] ?? [];
      const attachedSensors = allSensors.filter((s) => attachedIds.includes(s.id));
      const confirmedParams = [...new Set(attachedSensors.flatMap((s) => s.parameterSpecs.map((p) => p.parameter)))];

      const rules = (mine ? myAlertRules : alertRules).filter((r) => r.equipmentTemplateId === t.id);
      const scenariosLive = rules.filter((r) => r.active).length;

      const assets = seededInt(`${t.id}-assets`, 2, 90);
      const tier = (['T0', 'T0', 'T0', 'T1', 'T2'] as const)[seededInt(`${t.id}-tier`, 0, 4)];
      const sensorsPending = confirmedParams.length === 0 ? 0 : seededInt(`${t.id}-pending`, 0, 6);

      return { template: t, mine, assets, tier, confirmedParams, scenariosLive, sensorsPending };
    });
  }, [masterTemplates, myTemplates, templateSensorLinks, myTemplateSensorLinks, alertRules, myAlertRules, allSensors]);

  const totalEquipment = classes.reduce((sum, c) => sum + c.assets, 0);
  const totalScenariosLive = classes.reduce((sum, c) => sum + c.scenariosLive, 0);
  const totalSensorsPending = classes.reduce((sum, c) => sum + c.sensorsPending, 0);
  const tiers = [...new Set(classes.map((c) => c.tier))].sort();
  const tierMix = tiers.length ? `${tiers[0]}–${tiers[tiers.length - 1]}` : '—';

  return (
    <div id="client-fleet-dashboard" className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Boxes} label="Total Equipment" value={totalEquipment} note={`across ${classes.length} catalog classes`} />
        <StatCard icon={Layers} label="Scenarios Live" value={totalScenariosLive} note="actively scoring on live telemetry" color="text-sky-600" />
        <StatCard icon={Radio} label="Sensor Install Pending" value={totalSensorsPending} note="across classes with sensors attached" color="text-amber-600" />
        <StatCard icon={AlertTriangle} label="Tier Mix" value={tierMix} note="no class has 90+ days of labeled history yet" color="text-slate-700 dark:text-slate-200" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {classes.map((c) => (
          <div
            key={c.template.id}
            onClick={c.mine ? () => onOpenTemplate(c.template.id) : undefined}
            role={c.mine ? 'button' : undefined}
            title={c.mine ? undefined : 'From the Master Library — configured by Things Alive'}
            className={`text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs transition-all space-y-2.5 ${
              c.mine ? 'hover:border-sky-300 dark:hover:border-sky-700 cursor-pointer' : ''
            }`}
          >
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-slate-900 dark:text-white text-sm leading-snug">{c.template.name}</h4>
              <span className={`px-2 py-0.5 text-[10px] font-semibold rounded border shrink-0 ${TIER_STYLE[c.tier]}`}>{c.tier}</span>
            </div>

            <div>
              <span className="text-xl font-bold text-sky-700 dark:text-sky-400">{c.assets}</span>
              <span className="text-xs text-slate-400 ml-1.5">assets</span>
            </div>

            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
              {c.confirmedParams.length > 0
                ? <>Confirmed: {c.confirmedParams.slice(0, 3).join(', ')}{c.confirmedParams.length > 3 ? '…' : ''}</>
                : 'No sensors attached yet'}
            </p>

            {c.scenariosLive > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                {c.scenariosLive} scenario{c.scenariosLive === 1 ? '' : 's'} live
              </span>
            ) : c.sensorsPending > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                {c.sensorsPending} sensors pending
              </span>
            ) : (
              <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                catalog only
              </span>
            )}

            {c.mine ? (
              <span className="flex items-center gap-1 text-[10px] text-slate-400 pt-1 border-t border-slate-100 dark:border-slate-800">
                <ExternalLink className="w-2.5 h-2.5" /> My template
              </span>
            ) : (
              <span className="text-[10px] text-slate-300 dark:text-slate-600 pt-1 border-t border-slate-100 dark:border-slate-800 block">
                Master Library
              </span>
            )}
          </div>
        ))}

        {classes.length === 0 && (
          <div className="col-span-full py-10 text-center text-slate-400 text-sm">
            No equipment classes yet — add one from Administration → Equipment Templates.
          </div>
        )}
      </div>
    </div>
  );
};

interface StatCardProps {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string | number;
  note: string;
  color?: string;
}

const StatCard: React.FC<StatCardProps> = ({ icon: Icon, label, value, note, color }) => (
  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-1.5">
    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
      <Icon className="w-3.5 h-3.5" />
      {label}
    </div>
    <div className={`text-2xl font-bold ${color ?? 'text-slate-900 dark:text-white'}`}>{value}</div>
    <p className="text-[11px] text-slate-400">{note}</p>
  </div>
);
