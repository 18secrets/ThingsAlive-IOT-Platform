import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Clock3, Coins } from 'lucide-react';
import { SelectPicker } from 'rsuite';
import { usePageHeader } from '../lib/PageHeaderContext';
import { Modal } from '../components/common/Modal';
import { Chip } from '../components/common/Chip';
import {
  ApiError, EffectiveParameter, EquipmentClass, EquipmentProfile, ParameterCatalogEntry, ParameterScope, Plant,
  TenantParameterRow,
  apiGetEffectiveParameters, apiGetParameterCatalog, apiGetParameterHistory, apiListEquipment,
  apiListMyEquipmentClasses, apiListPlants, apiSetCurrency, apiSetParameter,
} from '../lib/api';

const SCOPE_LABEL: Record<ParameterScope, string> = {
  client: 'Whole account', site: 'One site', equipment_class: 'One equipment class', equipment: 'One machine',
};

export const CostAdministrationPage: React.FC = () => {
  usePageHeader({ title: 'Cost Administration', subtitle: 'Operational Parameters' });

  const [catalog, setCatalog] = useState<ParameterCatalogEntry[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [classes, setClasses] = useState<EquipmentClass[]>([]);
  const [equipment, setEquipment] = useState<EquipmentProfile[]>([]);
  const [effective, setEffective] = useState<EffectiveParameter[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [historyName, setHistoryName] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<TenantParameterRow[]>([]);

  const [scope, setScope] = useState<ParameterScope>('client');
  const [scopeRef, setScopeRef] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // Independent, not Promise.all — a failure loading one scope's picker
    // options shouldn't blank the catalog the others already loaded.
    apiListPlants().then((p) => { if (live) setPlants(p); }).catch(() => {});
    apiListMyEquipmentClasses().then((cl) => { if (live) setClasses(cl); }).catch(() => {});
    apiListEquipment().then((eq) => { if (live) setEquipment(eq); }).catch(() => {});
    apiGetParameterCatalog()
      .then((c) => { if (live) setCatalog(c); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Could not load parameters.'); });
    return () => { live = false; };
  }, []);

  const refreshEffective = async () => {
    const needsRef = scope !== 'client';
    if (needsRef && !scopeRef) { setEffective([]); return; }
    setLoading(true);
    try {
      setEffective(await apiGetEffectiveParameters({ scope, scopeRef: scopeRef ?? undefined }));
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load effective values.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refreshEffective(); }, [scope, scopeRef]); // eslint-disable-line react-hooks/exhaustive-deps

  const currency = effective.find((p) => p.name === 'currency');

  async function changeCurrency() {
    const entered = window.prompt('New 3-letter currency code (e.g. INR, USD):', (currency?.value as string) ?? '');
    if (!entered?.trim()) return;
    try {
      const result = await apiSetCurrency(entered.trim().toUpperCase());
      if (!result.changed) window.alert('Currency unchanged.');
      await refreshEffective();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not change the currency.');
    }
  }

  async function setValue(entry: ParameterCatalogEntry) {
    const current = effective.find((p) => p.name === entry.name);
    const entered = window.prompt(`${entry.name} (${entry.unit ?? 'number'}):`, current?.value != null ? String(current.value) : '');
    if (entered === null) return;
    const trimmed = entered.trim();
    const value = trimmed === '' ? null : Number(trimmed);
    if (value !== null && Number.isNaN(value)) { window.alert('Enter a number, or leave blank to clear.'); return; }
    setBusyName(entry.name);
    try {
      await apiSetParameter({ scope, scopeRef: scopeRef ?? undefined, name: entry.name, value });
      await refreshEffective();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not save this value.');
    } finally {
      setBusyName(null);
    }
  }

  async function openHistory(name: string) {
    setHistoryName(name);
    try {
      setHistoryRows(await apiGetParameterHistory(name, { scope, scopeRef: scopeRef ?? undefined }));
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not load history.');
      setHistoryName(null);
    }
  }

  const scopeRefOptions = useMemo(() => {
    if (scope === 'site') return plants.map((p) => ({ label: p.name, value: p.id }));
    if (scope === 'equipment_class') return classes.map((c) => ({ label: c.name, value: c.slug }));
    if (scope === 'equipment') return equipment.map((e) => ({ label: `${e.name ?? e.externalId} (${e.externalId})`, value: e.id }));
    return [];
  }, [scope, plants, classes, equipment]);

  return (
    <div id="cost-administration-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <h2 className="text-xl font-bold">Cost Administration</h2>
        <p className="text-sm text-sky-100">Client-owned operational parameters. No platform default is ever assumed.</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Coins className="w-5 h-5 text-slate-400" />
          <div>
            <p className="text-xs text-slate-400 dark:text-slate-500 uppercase tracking-wide">Account currency</p>
            <p className="text-lg font-semibold text-slate-800 dark:text-slate-100">{currency?.value ? String(currency.value) : 'Not set'}</p>
          </div>
        </div>
        <button onClick={changeCurrency} className="px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 cursor-pointer">
          Change currency
        </button>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl">
          <div className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Scope</span>
            <SelectPicker
              data={(Object.keys(SCOPE_LABEL) as ParameterScope[]).map((s) => ({ label: SCOPE_LABEL[s], value: s }))}
              value={scope}
              onChange={(value) => { setScope((value ?? 'client') as ParameterScope); setScopeRef(null); }}
              block
              searchable={false}
              cleanable={false}
            />
          </div>
          {scope !== 'client' && (
            <div className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Applies to</span>
              <SelectPicker
                data={scopeRefOptions}
                value={scopeRef}
                onChange={(value) => setScopeRef(value ?? null)}
                block
                searchable
                cleanable={false}
                placeholder="Select…"
              />
            </div>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : scope !== 'client' && !scopeRef ? (
          <p className="text-sm text-slate-400">Pick what this applies to.</p>
        ) : (
          <div className="space-y-2">
            {catalog.map((entry) => {
              const eff = effective.find((p) => p.name === entry.name);
              const setHere = eff?.source?.scope === scope && eff.source.scopeRef === scopeRef;
              return (
                <div key={entry.name} className="border border-slate-100 dark:border-slate-800 rounded-lg p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{entry.name}</h4>
                      {entry.costTyped && <Chip tone="amber">cost</Chip>}
                      {entry.source === 'formula' && <Chip tone="slate">formula-required</Chip>}
                    </div>
                    {entry.description && <p className="text-xs text-slate-400 dark:text-slate-500">{entry.description}</p>}
                    {entry.requiredBy.length > 0 && (
                      <p className="text-[11px] text-slate-400 dark:text-slate-500">
                        Needed by: {entry.requiredBy.map((r) => `${r.classSlug}/${r.formulaKey}`).join(', ')}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-base font-mono font-semibold text-slate-800 dark:text-slate-100">
                      {eff?.value != null ? `${eff.value} ${entry.unit ?? ''}` : '—'}
                    </div>
                    <p className="text-[10px] text-slate-400">
                      {eff?.source ? (setHere ? 'set here' : `inherited: ${SCOPE_LABEL[eff.source.scope]}`) : 'not configured'}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      disabled={busyName === entry.name || entry.kind !== 'number'}
                      onClick={() => setValue(entry)}
                      className="px-2.5 py-1 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 disabled:opacity-40 cursor-pointer"
                    >
                      Set
                    </button>
                    <button onClick={() => openHistory(entry.name)} className="px-2.5 py-1 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-sky-300 cursor-pointer">
                      History
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal isOpen={historyName !== null} onClose={() => setHistoryName(null)} title={`History: ${historyName ?? ''}`} subtitle="Effective-dated, newest first" maxWidth="max-w-lg">
        {historyRows.length === 0 ? (
          <p className="text-sm text-slate-400">No recorded values at this scope.</p>
        ) : (
          <div className="space-y-2">
            {historyRows.map((row) => (
              <div key={row.id} className="flex items-center justify-between border border-slate-100 dark:border-slate-800 rounded-lg p-2.5 text-sm">
                <span className="font-mono">{row.value != null ? `${row.value} ${row.unit ?? ''}` : 'cleared'}</span>
                <span className="flex items-center gap-1 text-xs text-slate-400"><Clock3 className="w-3.5 h-3.5" />{new Date(row.effectiveFrom).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
};
