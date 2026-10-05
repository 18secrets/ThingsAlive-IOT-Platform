import React, { useMemo, useState } from 'react';
import { usePageHeader } from '../lib/PageHeaderContext';
import {
  COST_FIELD_LABELS, CostField, CostRole, CostScope, MOCK_COST_PROFILES, MockCostProfile, costFields, mayEditCost,
} from '../data/clientOpsMockData';
import { FLEET, FLEET_LOCATIONS } from '../data/fleetMockData';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';

const SCOPE_ORDER: CostScope[] = ['administration', 'client', 'site', 'equipment'];

function blankProfile(): MockCostProfile {
  return {
    id: '', scope: 'administration', target: '*', currency: 'INR', effectiveFrom: '2026-09-17',
    fuelPerL: null, oilPerL: null, maintenance: null, filterReplacement: null, downtimePerHour: null, baselineFuelPerHour: null, implementationCost: null,
  };
}

export const CostAdministrationPage: React.FC = () => {
  usePageHeader({ title: 'Cost Administration', subtitle: 'Fuel & Maintenance Rates' });
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const [selectedId, setSelectedId] = useState('all');
  const matching = useMemo(() => matchingFleet(FLEET, scope), [scope]);

  const [role, setRole] = useState<CostRole>('administrator');
  const [form, setForm] = useState<MockCostProfile>(blankProfile());
  const [review, setReview] = useState(false);
  const [profiles, setProfiles] = useState<MockCostProfile[]>(MOCK_COST_PROFILES);
  const [notice, setNotice] = useState('');

  const editable = mayEditCost(role, form.scope);

  function update(change: Partial<MockCostProfile>) {
    setForm((f) => ({ ...f, ...change }));
    setReview(false);
  }

  function save() {
    const previous = profiles
      .filter((p) => p.scope === form.scope && p.target === form.target)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      .at(-1);
    if (previous && form.effectiveFrom <= previous.effectiveFrom) {
      setNotice('A new version must start after the previous effective date. Existing rates are preserved.');
      return;
    }
    setProfiles((current) => [...current, { ...form, id: crypto.randomUUID() }]);
    setReview(false);
    setNotice('Cost version saved. Applicable calculations updated.');
  }

  return (
    <div id="cost-administration-view" className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">Cost Administration</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">From machine signals to your next best action.</p>
      </div>

      <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId={selectedId} onSelectId={(id) => { setSelectedId(id); if (form.scope === 'equipment' && id !== 'all') update({ target: id }); }} />

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Cost administration</h3>
          <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-1">
            Equipment → Site → Client → Administration defaults. Rates are effective-dated; blank fields inherit a rate in the same currency. Records are saved in this browser.
          </p>
        </div>

        <label className="block space-y-1 max-w-xs">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Demo role (not security permissions)</span>
          <select
            value={role}
            onChange={(e) => {
              const next = e.target.value as CostRole;
              setRole(next);
              setReview(false);
              if (next !== 'administrator') update({ scope: 'client', target: 'default' });
            }}
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm"
          >
            <option value="administrator">Administration</option>
            <option value="client-admin">Client Admin</option>
            <option value="operator">Operator (read-only)</option>
          </select>
        </label>
        <p className="text-[12px] text-slate-400 dark:text-slate-500">Access: {role}</p>
        {notice && <p className="text-[13px] text-sky-700 dark:text-sky-400">{notice}</p>}

        <fieldset disabled={!editable} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Scope</span>
              <select
                value={form.scope}
                onChange={(e) => {
                  const next = e.target.value as CostScope;
                  update({ scope: next, target: next === 'administration' ? '*' : next === 'client' ? 'default' : next === 'site' ? (FLEET_LOCATIONS[0] || '') : (FLEET[0]?.id || '') });
                }}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm"
              >
                {(role === 'administrator' ? SCOPE_ORDER : SCOPE_ORDER.filter((s) => s !== 'administration')).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            {(form.scope === 'site' || form.scope === 'equipment') && (
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Applies to</span>
                <select value={form.target} onChange={(e) => update({ target: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm">
                  {(form.scope === 'site' ? FLEET_LOCATIONS.map((l) => ({ id: l, name: l })) : FLEET).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            )}
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Currency (client/site)</span>
              <input required maxLength={3} value={form.currency} onChange={(e) => update({ currency: e.target.value.toUpperCase() })} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Effective from</span>
              <input type="date" required value={form.effectiveFrom} onChange={(e) => update({ effectiveFrom: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {costFields.map((field) => (
              <label key={field} className="block space-y-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{COST_FIELD_LABELS[field as CostField]}</span>
                <input
                  type="number" step="any" min="0" placeholder="Inherit / not configured"
                  value={form[field as CostField] ?? ''}
                  onChange={(e) => update({ [field]: e.target.value === '' ? null : Number(e.target.value) } as Partial<MockCostProfile>)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-3 py-2 text-sm"
                />
              </label>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setReview(true)}
            className="px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700"
          >
            Review cost configuration
          </button>
        </fieldset>

        {review && editable && (
          <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg p-4 space-y-2">
            <h4 className="font-semibold text-slate-900 dark:text-white text-sm">Confirm cost version</h4>
            <p className="text-[13px] text-slate-600 dark:text-slate-300">{form.scope} · {form.target} · {form.currency} · from {form.effectiveFrom}</p>
            <ul className="text-[12px] text-slate-500 dark:text-slate-400 list-disc pl-4 space-y-0.5">
              {costFields.map((f) => <li key={f}>{COST_FIELD_LABELS[f as CostField]}: {form[f as CostField] ?? 'Inherit / unavailable'}</li>)}
            </ul>
            <div className="flex items-center gap-2 pt-1">
              <button onClick={save} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">Confirm costs</button>
              <button onClick={() => setReview(false)} className="px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Cancel</button>
            </div>
          </div>
        )}

        <div>
          <h4 className="font-semibold text-slate-900 dark:text-white text-sm mb-2">Rate history</h4>
          {!profiles.length ? (
            <p className="text-[13px] text-slate-400">No costs configured. No default market prices are assumed. To apply costs to the sample week, use an effective date on or before 23 September 2026.</p>
          ) : (
            <div className="space-y-2">
              {profiles.map((p) => (
                <div key={p.id} className="border border-slate-200 dark:border-slate-800 rounded-lg p-3">
                  <strong className="text-sm text-slate-800 dark:text-slate-100">{p.scope} · {p.target} · {p.currency} · {p.effectiveFrom}</strong>
                  <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-1">
                    {costFields.map((f) => `${COST_FIELD_LABELS[f as CostField]}: ${p[f as CostField] ?? 'Inherit'}`).join(' · ')}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
