import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { FLEET, findThing } from '../data/fleetMockData';
import {
  CATEGORY_LABELS, MOCK_INCIDENTS, REGULATION_APPLICABILITY, SHIELD_CATEGORIES, ShieldCategory,
  ShieldEvidenceRecord, ShieldIncident, evidenceRecordsFor, shieldSummaryFor,
} from '../data/shieldMockData';
import { EvidenceRecordCard, EvidenceRecordForm } from '../components/shield/EvidenceRecord';
import { FeatureCrossLinks } from '../components/fleet/FeatureCrossLinks';
import { IncidentManagementSection } from '../components/shield/IncidentManagementSection';

export const ThingsShieldDetailPage: React.FC = () => {
  const { thingId } = useParams<{ thingId: string }>();
  const navigate = useNavigate();
  const thing = thingId ? findThing(thingId) : undefined;
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const matching = useMemo(() => matchingFleet(FLEET, scope), [scope]);
  usePageHeader({
    title: thing ? thing.name : 'Thing not found',
    subtitle: 'ThingsShield Detail',
    onBack: () => navigate('/things-shield'),
  });

  const [category, setCategory] = useState<ShieldCategory>('compliance');
  const [records, setRecords] = useState<ShieldEvidenceRecord[]>(() => (thing ? evidenceRecordsFor(thing) : []));
  const [addingNew, setAddingNew] = useState(false);
  const [editingRecord, setEditingRecord] = useState<ShieldEvidenceRecord | null>(null);
  const [incidents, setIncidents] = useState<ShieldIncident[]>(MOCK_INCIDENTS);

  useEffect(() => {
    setRecords(thing ? evidenceRecordsFor(thing) : []);
    setCategory('compliance');
    setAddingNew(false);
    setEditingRecord(null);
  }, [thing?.id]);

  if (!thing) {
    return (
      <div className="space-y-4">
        <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId="all" onSelectId={(id) => navigate(`/things-shield/${id}`)} />
        <p className="text-sm text-slate-500">This Thing could not be found.</p>
      </div>
    );
  }

  const summary = shieldSummaryFor(thing, incidents);
  const categoryRecords = records.filter((r) => r.category === category);
  const visibleIncidents = incidents.filter((i) => i.equipmentCode === thing.id);

  function saveRecord(data: { title: string; reference: string; owner: string; dueDate: string; result: ShieldEvidenceRecord['result'] | 'Not assessed'; findings: string; reviewer: string; recordedBy: string }) {
    const status: ShieldEvidenceRecord['status'] = data.result === 'Failed' ? 'Action required' : data.result === 'Attention' ? 'Due soon' : 'Current';
    if (editingRecord) {
      setRecords((current) => current.map((r) => (r.id === editingRecord.id
        ? { ...r, title: data.title, reference: data.reference, owner: data.owner, dueDate: data.dueDate, result: data.result === 'Not assessed' ? r.result : data.result, status: data.result === 'Not assessed' ? r.status : status, findings: data.findings, reviewer: data.reviewer, recordedBy: data.recordedBy }
        : r)));
    } else {
      setRecords((current) => [
        ...current,
        {
          id: crypto.randomUUID(), thingId: thing.id, category, title: data.title, reference: data.reference, owner: data.owner,
          dueDate: data.dueDate, result: data.result === 'Not assessed' ? 'Attention' : data.result, status: data.result === 'Not assessed' ? 'Due soon' : status,
          note: 'Added from this console; not a real certificate or test evidence.', findings: data.findings, reviewer: data.reviewer, recordedBy: data.recordedBy,
          createdAt: new Date().toISOString(),
        },
      ]);
    }
    setAddingNew(false);
    setEditingRecord(null);
  }

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-[11px] font-semibold tracking-wider uppercase text-sky-100">People · Machines · Evidence</span>
        <h2 className="text-xl font-bold">ThingsShield: Safety, Compliance &amp; Risk</h2>
        <p className="text-sm text-sky-100">Inspections, site requirements, safety records and corrective actions.</p>
      </div>

      <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId={thing.id} onSelectId={(id) => navigate(id === 'all' ? '/things-shield' : `/things-shield/${id}`)} />

      <div className="flex flex-wrap gap-2">
        {SHIELD_CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => { setCategory(c); setAddingNew(false); setEditingRecord(null); }}
            className={`px-3.5 py-2 text-sm font-medium rounded-lg ${category === c ? 'bg-sky-600 text-white' : 'border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}
          >
            {CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white text-sm">{thing.name}</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400">{thing.id} · {thing.location}</p>
          </div>
          <span className="text-[11px] text-slate-300 dark:text-slate-600 cursor-not-allowed" title="Not available in this demo">Sample history</span>
        </div>
        <p className="text-[12px] text-slate-500 dark:text-slate-400">
          {summary.evidenceRecords} evidence records · {summary.currentPassed} current &amp; passed · {summary.overdueFailed} overdue/failed · {summary.openIncidents} open incidents
        </p>

        <div>
          <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{CATEGORY_LABELS[category]} records</h4>
          <p className="text-[12px] text-slate-500 dark:text-slate-400">{categoryRecords.filter((r) => r.status === 'Current').length} / {categoryRecords.length} records current and passed · sample records do not establish certification, SIL or PL.</p>
        </div>

        {category === 'regulation' && (
          <div className="border border-slate-100 dark:border-slate-800 rounded-lg p-3 space-y-2">
            <p className="text-[12px] font-medium text-slate-700 dark:text-slate-200">{REGULATION_APPLICABILITY.jurisdiction} · {REGULATION_APPLICABILITY.status} · {REGULATION_APPLICABILITY.label}</p>
            <p className="text-[12px] text-slate-500 dark:text-slate-400">{REGULATION_APPLICABILITY.description}</p>
            <button disabled className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed" title="Not available in this demo">
              Configure site requirements
            </button>
          </div>
        )}

        <div className="space-y-3">
          {categoryRecords.map((r) => (
            editingRecord?.id === r.id ? (
              <EvidenceRecordForm key={r.id} initial={r} onCancel={() => setEditingRecord(null)} onSave={saveRecord} />
            ) : (
              <EvidenceRecordCard key={r.id} record={r} onEdit={() => { setEditingRecord(r); setAddingNew(false); }} />
            )
          ))}
        </div>

        {addingNew ? (
          <EvidenceRecordForm onCancel={() => setAddingNew(false)} onSave={saveRecord} />
        ) : (
          <button onClick={() => { setAddingNew(true); setEditingRecord(null); }} className="px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-sky-300">
            Add evidence record
          </button>
        )}

        <FeatureCrossLinks thingId={thing.id} current="things-shield" />
      </div>

      <IncidentManagementSection things={[thing]} visibleIncidents={visibleIncidents} setIncidents={setIncidents} defaultThingId={thing.id} />
    </div>
  );
};
