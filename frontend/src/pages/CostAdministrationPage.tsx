import React, { useMemo, useState } from 'react';
import { DatePicker, Input, InputNumber, SelectPicker } from 'rsuite';
import { usePageHeader } from '../lib/PageHeaderContext';
import {
  COST_FIELD_LABELS, CostField, CostRole, CostScope, MOCK_COST_PROFILES, MockCostProfile, costFields, mayEditCost,
} from '../data/clientOpsMockData';
import { FLEET, FLEET_LOCATIONS } from '../data/fleetMockData';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { Modal } from '../components/common/Modal';

const SCOPE_ORDER: CostScope[] = ['administration', 'client', 'site', 'equipment'];

// form.effectiveFrom is stored as a plain 'YYYY-MM-DD' string (it's compared with
// string.localeCompare elsewhere); DatePicker works in Date objects, so these
// convert at the edges rather than changing the stored representation.
function parseIsoDate(value: string): Date | null {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function blankProfile(role: CostRole, presetEquipmentId?: string): MockCostProfile {
  const base = {
    id: '', currency: 'INR', effectiveFrom: '2026-09-17',
    fuelPerL: null, oilPerL: null, maintenance: null, filterReplacement: null, downtimePerHour: null, baselineFuelPerHour: null, implementationCost: null,
  };
  if (presetEquipmentId) return { ...base, scope: 'equipment', target: presetEquipmentId };
  if (role !== 'administrator') return { ...base, scope: 'client', target: 'default' };
  return { ...base, scope: 'administration', target: '*' };
}

export const CostAdministrationPage: React.FC = () => {
  usePageHeader({ title: 'Cost Administration', subtitle: 'Fuel & Maintenance Rates' });
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const [selectedId, setSelectedId] = useState('all');
  const matching = useMemo(() => matchingFleet(FLEET, scope), [scope]);

  const [role, setRole] = useState<CostRole>('administrator');
  const [profiles, setProfiles] = useState<MockCostProfile[]>(MOCK_COST_PROFILES);
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);

  function handleSave(profile: MockCostProfile) {
    setProfiles((current) => [...current, profile]);
    setNotice('Cost version saved. Applicable calculations updated.');
    setAdding(false);
  }

  return (
    <div id="cost-administration-view" className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <h2 className="text-xl font-bold">Cost Administration</h2>
        <p className="text-sm text-sky-100">From machine signals to your next best action.</p>
      </div>

      <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId={selectedId} onSelectId={setSelectedId} />

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Cost administration</h3>
            <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-1">
              Equipment → Site → Client → Administration defaults. Rates are effective-dated; blank fields inherit a rate in the same currency. Records are saved in this browser.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 shrink-0"
          >
            Add cost version
          </button>
        </div>

        <div className="block space-y-1 max-w-xs">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Demo role (not security permissions)</span>
          <SelectPicker
            data={[
              { label: 'Administration', value: 'administrator' },
              { label: 'Client Admin', value: 'client-admin' },
              { label: 'Operator (read-only)', value: 'operator' },
            ]}
            value={role}
            onChange={(value) => setRole((value ?? 'administrator') as CostRole)}
            block
            searchable={false}
            cleanable={false}
          />
        </div>
        <p className="text-[12px] text-slate-400 dark:text-slate-500">Access: {role}</p>
        {notice && <p className="text-[13px] text-sky-700 dark:text-sky-400">{notice}</p>}

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

      <Modal isOpen={adding} onClose={() => setAdding(false)} title="Add cost version" subtitle="New Rate Record" maxWidth="max-w-2xl">
        <CostProfileForm
          role={role}
          presetEquipmentId={selectedId !== 'all' ? selectedId : undefined}
          existingProfiles={profiles}
          onCancel={() => setAdding(false)}
          onSave={handleSave}
        />
      </Modal>
    </div>
  );
};

const CostProfileForm: React.FC<{
  role: CostRole;
  presetEquipmentId?: string;
  existingProfiles: MockCostProfile[];
  onCancel: () => void;
  onSave: (profile: MockCostProfile) => void;
}> = ({ role, presetEquipmentId, existingProfiles, onCancel, onSave }) => {
  const [form, setForm] = useState<MockCostProfile>(() => blankProfile(role, presetEquipmentId));
  const [review, setReview] = useState(false);
  const [error, setError] = useState('');

  const editable = mayEditCost(role, form.scope);

  function update(change: Partial<MockCostProfile>) {
    setForm((f) => ({ ...f, ...change }));
    setReview(false);
  }

  function confirm() {
    const previous = existingProfiles
      .filter((p) => p.scope === form.scope && p.target === form.target)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      .at(-1);
    if (previous && form.effectiveFrom <= previous.effectiveFrom) {
      setError('A new version must start after the previous effective date. Existing rates are preserved.');
      return;
    }
    onSave({ ...form, id: crypto.randomUUID() });
  }

  if (review) {
    return (
      <div className="space-y-4">
        <h4 className="font-semibold text-slate-900 dark:text-white text-sm">Confirm cost version</h4>
        <p className="text-[13px] text-slate-600 dark:text-slate-300">{form.scope} · {form.target} · {form.currency} · from {form.effectiveFrom}</p>
        <ul className="text-[12px] text-slate-500 dark:text-slate-400 list-disc pl-4 space-y-0.5">
          {costFields.map((f) => <li key={f}>{COST_FIELD_LABELS[f as CostField]}: {form[f as CostField] ?? 'Inherit / unavailable'}</li>)}
        </ul>
        {error && <p className="text-[13px] text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <button type="button" onClick={() => setReview(false)} className="text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Back</button>
          <div className="flex items-center gap-3">
            <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
              Cancel
            </button>
            <button type="button" onClick={confirm} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors">
              Confirm costs
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!editable && <p className="text-[13px] text-amber-600 dark:text-amber-400">The "{role}" demo role can&apos;t edit this scope.</p>}
      <fieldset disabled={!editable} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Scope</span>
            <SelectPicker
              data={(role === 'administrator' ? SCOPE_ORDER : SCOPE_ORDER.filter((s) => s !== 'administration')).map((s) => ({ label: s, value: s }))}
              value={form.scope}
              onChange={(value) => {
                const next = (value ?? form.scope) as CostScope;
                update({ scope: next, target: next === 'administration' ? '*' : next === 'client' ? 'default' : next === 'site' ? (FLEET_LOCATIONS[0] || '') : (FLEET[0]?.id || '') });
              }}
              block
              searchable={false}
              cleanable={false}
            />
          </div>
          {(form.scope === 'site' || form.scope === 'equipment') && (
            <div className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Applies to</span>
              <SelectPicker
                data={(form.scope === 'site' ? FLEET_LOCATIONS.map((l) => ({ id: l, name: l })) : FLEET).map((t) => ({ label: t.name, value: t.id }))}
                value={form.target}
                onChange={(value) => update({ target: value ?? '' })}
                block
                searchable={false}
                cleanable={false}
              />
            </div>
          )}
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Currency (client/site)</span>
            <Input required maxLength={3} value={form.currency} onChange={(value) => update({ currency: value.toUpperCase() })} />
          </label>
          <div className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Effective from</span>
            <DatePicker
              value={parseIsoDate(form.effectiveFrom)}
              onChange={(date) => update({ effectiveFrom: date ? toIsoDate(date) : '' })}
              format="yyyy-MM-dd"
              oneTap
              cleanable={false}
              block
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {costFields.map((field) => (
            <label key={field} className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{COST_FIELD_LABELS[field as CostField]}</span>
              <InputNumber
                min={0}
                placeholder="Inherit / not configured"
                value={form[field as CostField] ?? undefined}
                onChange={(value) => update({ [field]: value === '' || value === undefined ? null : Number(value) } as Partial<MockCostProfile>)}
              />
            </label>
          ))}
        </div>
      </fieldset>

      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => setReview(true)}
          disabled={!editable}
          className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Review cost configuration
        </button>
      </div>
    </div>
  );
};
