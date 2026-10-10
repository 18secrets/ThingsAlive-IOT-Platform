import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, AlertTriangle, CheckCircle2, Plus, Sparkles } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Modal } from '../components/common/Modal';
import { Chip } from '../components/common/Chip';
import {
  AlertEvent, AlertRule, AlertRuleInput, AlertRuleSeverity, AlertTrigger, ApiError, EquipmentProfile, Plant,
  SignalThresholdParams, PredictionSeverityParams,
  apiAcknowledgeAlert, apiCreateAlertRule, apiDisableAlertRule, apiEnableAlertRule, apiListAlertRules,
  apiListAlerts, apiListEquipment, apiListPlants, apiResolveAlert, apiUpdateAlertRule,
} from '../lib/api';

const SEVERITY_TONE: Record<AlertRuleSeverity, 'slate' | 'sky' | 'amber' | 'rose'> = {
  none: 'slate', low: 'sky', medium: 'sky', high: 'amber', critical: 'rose',
};
const SEVERITY_OPTIONS: AlertRuleSeverity[] = ['none', 'low', 'medium', 'high', 'critical'];
const TRIGGER_LABEL: Record<AlertTrigger, string> = {
  'prediction-severity': 'Prediction severity',
  'signal-threshold': 'Signal threshold',
  'no-telemetry': 'No telemetry',
  'fuel-loss': 'Fuel loss',
  'chain-origin': 'Chain origin',
};
// This form only authors the three trigger kinds a client can set up without extra
// context (a live GPS fix for fuel-loss, a resolved causal chain for chain-origin).
// Existing rules of any trigger still display; creating/editing stays to these three.
const CREATABLE_TRIGGERS: AlertTrigger[] = ['prediction-severity', 'signal-threshold', 'no-telemetry'];

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'rule';
}

function ruleScopeText(rule: AlertRule, plants: Plant[], equipment: EquipmentProfile[]): string {
  if (rule.appliesTo === 'plant' && rule.plantId) return plants.find((p) => p.id === rule.plantId)?.name ?? 'Unknown plant';
  if (rule.appliesTo === 'equipment' && rule.sourceSystem && rule.externalId) {
    const match = equipment.find((e) => e.sourceSystem === rule.sourceSystem && e.externalId === rule.externalId);
    return match?.name ?? rule.externalId;
  }
  if (rule.appliesTo === 'equipment-class') return rule.equipmentClassSlug ?? 'Equipment class';
  return 'Whole account';
}

export const AlertsPage: React.FC = () => {
  usePageHeader({ title: 'Alerts', subtitle: 'Fleet Attention Feed' });
  const navigate = useNavigate();

  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [equipment, setEquipment] = useState<EquipmentProfile[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<AlertRule | 'new' | null>(null);

  const refreshEvents = () => apiListAlerts({ state: ['open', 'acknowledged'] }).then(setEvents);
  const refreshRules = () => apiListAlertRules().then(setRules);

  useEffect(() => {
    let live = true;
    setLoading(true);
    // Independent, not Promise.all — one failing fetch (e.g. no plants yet)
    // shouldn't blank out data the others already loaded.
    apiListPlants().then((p) => { if (live) setPlants(p); }).catch(() => {});
    apiListEquipment().then((eq) => { if (live) setEquipment(eq); }).catch(() => {});
    apiListAlertRules().then((r) => { if (live) setRules(r); }).catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load alert rules.'); });
    apiListAlerts({ state: ['open', 'acknowledged'] })
      .then((e) => { if (live) { setEvents(e); setError(undefined); } })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load alerts.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  async function acknowledge(id: string) {
    setBusyId(id);
    try {
      await apiAcknowledgeAlert(id);
      await refreshEvents();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not acknowledge this alert.');
    } finally {
      setBusyId(null);
    }
  }

  async function resolve(id: string) {
    const note = window.prompt('What was found / done?');
    if (!note?.trim()) return;
    setBusyId(id);
    try {
      await apiResolveAlert(id, note.trim());
      await refreshEvents();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not resolve this alert.');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleRule(rule: AlertRule) {
    setBusyId(rule.id);
    try {
      if (rule.enabled) await apiDisableAlertRule(rule.id); else await apiEnableAlertRule(rule.id);
      await refreshRules();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not change this rule.');
    } finally {
      setBusyId(null);
    }
  }

  async function saveRule(input: AlertRuleInput) {
    try {
      if (editingRule && editingRule !== 'new') {
        await apiUpdateAlertRule(editingRule.id, input);
      } else {
        await apiCreateAlertRule(input);
      }
      setEditingRule(null);
      await refreshRules();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not save this rule.');
    }
  }

  const openCount = useMemo(() => events.filter((e) => e.state === 'open').length, [events]);

  return (
    <div id="alerts-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <h2 className="text-xl font-bold">Things Alerts</h2>
        <p className="text-sm text-sky-100">From machine signals to your next best action.</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base">Configured alert rules</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setEditingRule('new')}
              className="px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 cursor-pointer inline-flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" /> Create alert
            </button>
            <button
              onClick={() => navigate('/alert-agent', { state: { view: 'assistant', backTo: '/alerts' } })}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-sky-300 cursor-pointer"
            >
              <Sparkles className="w-4 h-4" /> Create alert with AI
            </button>
          </div>
        </div>
        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : rules.length === 0 ? (
          <p className="text-sm text-slate-400">No alert rules configured yet.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {rules.map((r) => (
              <div key={r.id} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3.5 space-y-1.5">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{r.name}</h4>
                  <button
                    disabled={busyId === r.id}
                    onClick={() => toggleRule(r)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer disabled:opacity-50 ${r.enabled ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'}`}
                    title={r.enabled ? 'Disable' : 'Enable'}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${r.enabled ? 'translate-x-4.5' : 'translate-x-1'}`} />
                  </button>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Chip tone={SEVERITY_TONE[r.severity]}>{r.severity}</Chip>
                  <Chip tone="slate">{TRIGGER_LABEL[r.trigger]}</Chip>
                  {r.templateSlug && <Chip tone="slate">from template</Chip>}
                </div>
                <p className="text-xs text-slate-400 dark:text-slate-500">{ruleScopeText(r, plants, equipment)}</p>
                {CREATABLE_TRIGGERS.includes(r.trigger) && (
                  <button onClick={() => setEditingRule(r)} className="text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline cursor-pointer">
                    Edit
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white text-base mb-1">Open alerts</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{openCount} open · {events.length - openCount} acknowledged</p>

        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : events.length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col items-center gap-2">
            <CheckCircle2 className="w-6 h-6" /> No open alerts.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {events.map((e) => {
              const name = equipment.find((eq) => eq.sourceSystem === e.sourceSystem && eq.externalId === e.externalId)?.name ?? e.externalId;
              return (
                <div key={e.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <Chip icon={AlertTriangle} tone={SEVERITY_TONE[e.severity]}>{e.severity}</Chip>
                    <Chip tone={e.state === 'open' ? 'rose' : 'amber'}>{e.state}</Chip>
                  </div>
                  <h4 className="font-semibold text-slate-900 dark:text-white text-base">{e.ruleName}</h4>
                  <p className="text-sm text-slate-500 dark:text-slate-400">{name}</p>
                  <p className="text-sm text-slate-600 dark:text-slate-300">{e.summary}</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500">{new Date(e.firedAt).toLocaleString()}</p>
                  <div className="flex items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                    {e.state === 'open' && (
                      <button disabled={busyId === e.id} onClick={() => acknowledge(e.id)} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 disabled:opacity-50 cursor-pointer">
                        Acknowledge
                      </button>
                    )}
                    <button disabled={busyId === e.id} onClick={() => resolve(e.id)} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-emerald-300 disabled:opacity-50 cursor-pointer">
                      Resolve
                    </button>
                    <button
                      onClick={() => navigate(`/admin/equipment/${encodeURIComponent(e.sourceSystem)}/${encodeURIComponent(e.externalId)}/page`)}
                      className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 cursor-pointer ml-auto"
                    >
                      View machine
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal
        isOpen={editingRule !== null}
        onClose={() => setEditingRule(null)}
        title={editingRule !== 'new' ? 'Edit alert rule' : 'Create alert rule'}
        subtitle="Alert Rule"
        maxWidth="max-w-xl"
      >
        <AlertRuleForm
          rule={editingRule !== 'new' ? editingRule ?? undefined : undefined}
          plants={plants}
          equipment={equipment}
          onCancel={() => setEditingRule(null)}
          onSave={saveRule}
        />
      </Modal>
    </div>
  );
};

const AlertRuleForm: React.FC<{
  rule?: AlertRule;
  plants: Plant[];
  equipment: EquipmentProfile[];
  onCancel: () => void;
  onSave: (input: AlertRuleInput) => void;
}> = ({ rule, plants, equipment, onCancel, onSave }) => {
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [trigger, setTrigger] = useState<AlertTrigger>(rule?.trigger ?? 'signal-threshold');
  const [severity, setSeverity] = useState<AlertRuleSeverity>(rule?.severity ?? 'high');
  const [appliesTo, setAppliesTo] = useState<'account' | 'plant' | 'equipment'>(
    rule?.appliesTo === 'plant' || rule?.appliesTo === 'equipment' ? rule.appliesTo : 'account',
  );
  const [plantId, setPlantId] = useState<string | null>(rule?.plantId ?? null);
  const [equipmentKey, setEquipmentKey] = useState<string | null>(
    rule?.sourceSystem && rule?.externalId ? `${rule.sourceSystem}|${rule.externalId}` : null,
  );

  const thresholdParams = (rule?.trigger === 'signal-threshold' ? rule.params as SignalThresholdParams : undefined);
  const [signal, setSignal] = useState(thresholdParams?.signal ?? '');
  const [min, setMin] = useState(thresholdParams?.min != null ? String(thresholdParams.min) : '');
  const [max, setMax] = useState(thresholdParams?.max != null ? String(thresholdParams.max) : '');

  const predictionParams = (rule?.trigger === 'prediction-severity' ? rule.params as PredictionSeverityParams : undefined);
  const [atLeast, setAtLeast] = useState<AlertRuleSeverity>((predictionParams?.atLeast as AlertRuleSeverity) ?? 'high');
  const [clientScenarioSlug, setClientScenarioSlug] = useState(predictionParams?.clientScenarioSlug ?? '');

  function buildParams(): SignalThresholdParams | PredictionSeverityParams | Record<string, never> {
    if (trigger === 'signal-threshold') {
      return {
        signal: signal.trim(),
        min: min.trim() ? Number(min) : null,
        max: max.trim() ? Number(max) : null,
      };
    }
    if (trigger === 'prediction-severity') {
      return { atLeast, clientScenarioSlug: clientScenarioSlug.trim() || null };
    }
    return {};
  }

  function valid(): boolean {
    if (!name.trim()) return false;
    if (trigger === 'signal-threshold' && (!signal.trim() || (!min.trim() && !max.trim()))) return false;
    if (appliesTo === 'plant' && !plantId) return false;
    if (appliesTo === 'equipment' && !equipmentKey) return false;
    return true;
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid()) return;
        const [sourceSystem, externalId] = equipmentKey ? equipmentKey.split('|') : [undefined, undefined];
        onSave({
          slug: rule?.slug ?? slugify(name),
          name: name.trim(),
          description: description.trim() || undefined,
          trigger,
          params: buildParams(),
          appliesTo,
          plantId: appliesTo === 'plant' ? plantId ?? undefined : undefined,
          sourceSystem: appliesTo === 'equipment' ? sourceSystem : undefined,
          externalId: appliesTo === 'equipment' ? externalId : undefined,
          severity,
        });
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Name</span>
        <Input required value={name} onChange={(value) => setName(value)} placeholder="e.g. Coolant temperature guard" />
      </label>

      <div className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">What it watches</span>
        <SelectPicker
          data={CREATABLE_TRIGGERS.map((t) => ({ label: TRIGGER_LABEL[t], value: t }))}
          value={trigger}
          onChange={(value) => setTrigger((value ?? 'signal-threshold') as AlertTrigger)}
          block
          searchable={false}
          cleanable={false}
          disabled={!!rule}
        />
      </div>

      {trigger === 'signal-threshold' && (
        <div className="grid grid-cols-3 gap-3">
          <label className="block space-y-1 col-span-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Signal</span>
            <Input required value={signal} onChange={(value) => setSignal(value)} placeholder="coolant_temperature" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Min</span>
            <Input value={min} onChange={(value) => setMin(value)} placeholder="optional" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Max</span>
            <Input value={max} onChange={(value) => setMax(value)} placeholder="optional" />
          </label>
        </div>
      )}

      {trigger === 'prediction-severity' && (
        <div className="grid grid-cols-2 gap-3">
          <div className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Fires at least</span>
            <SelectPicker
              data={SEVERITY_OPTIONS.map((s) => ({ label: s, value: s }))}
              value={atLeast}
              onChange={(value) => setAtLeast((value ?? 'high') as AlertRuleSeverity)}
              block
              searchable={false}
              cleanable={false}
            />
          </div>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Scenario (optional)</span>
            <Input value={clientScenarioSlug ?? ''} onChange={(value) => setClientScenarioSlug(value)} placeholder="any scenario" />
          </label>
        </div>
      )}

      {trigger === 'no-telemetry' && (
        <p className="text-xs text-slate-400">Fires when a shift produced no readings at all. Nothing else to configure.</p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Severity</span>
          <SelectPicker
            data={SEVERITY_OPTIONS.map((s) => ({ label: s, value: s }))}
            value={severity}
            onChange={(value) => setSeverity((value ?? 'high') as AlertRuleSeverity)}
            block
            searchable={false}
            cleanable={false}
          />
        </div>
        <div className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Applies to</span>
          <SelectPicker
            data={[{ label: 'Whole account', value: 'account' }, { label: 'One site', value: 'plant' }, { label: 'One machine', value: 'equipment' }]}
            value={appliesTo}
            onChange={(value) => setAppliesTo((value ?? 'account') as 'account' | 'plant' | 'equipment')}
            block
            searchable={false}
            cleanable={false}
          />
        </div>
      </div>

      {appliesTo === 'plant' && (
        <div className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Site</span>
          <SelectPicker
            data={plants.map((p) => ({ label: p.name, value: p.id }))}
            value={plantId}
            onChange={(value) => setPlantId(value ?? null)}
            block
            searchable
            cleanable={false}
          />
        </div>
      )}

      {appliesTo === 'equipment' && (
        <div className="block space-y-1">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Equipment</span>
          <SelectPicker
            data={equipment.map((e) => ({ label: `${e.name ?? e.externalId} (${e.externalId})`, value: `${e.sourceSystem}|${e.externalId}` }))}
            value={equipmentKey}
            onChange={(value) => setEquipmentKey(value ?? null)}
            block
            searchable
            cleanable={false}
          />
        </div>
      )}

      <label className="block space-y-1">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Description (optional)</span>
        <Input as="textarea" rows={2} value={description ?? ''} onChange={(value) => setDescription(value)} />
      </label>

      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer">
          Cancel
        </button>
        <button type="submit" disabled={!valid()} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer">
          {rule ? 'Save changes' : 'Create alert'}
        </button>
      </div>
    </form>
  );
};
