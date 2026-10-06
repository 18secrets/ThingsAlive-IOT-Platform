import React, { useMemo, useState } from 'react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { FleetFilters, DEFAULT_FLEET_SCOPE, matchingFleet } from '../components/fleet/FleetFilters';
import { FLEET } from '../data/fleetMockData';
import { MOCK_INCIDENTS, ShieldIncident } from '../data/shieldMockData';
import { IncidentManagementSection } from '../components/shield/IncidentManagementSection';

// Same incident model and MOCK_INCIDENTS seed as ThingsShield's embedded
// section (see shieldMockData.ts) — this page is the fleet-wide, standalone
// view of it; each keeps its own local state, so edits made here don't carry
// over into ThingsShield's view or back, same as Work Orders' local state.
export const IncidentManagementPage: React.FC = () => {
  usePageHeader({ title: 'Incident Management', subtitle: 'People, Machine Wellbeing & Security' });
  const [scope, setScope] = useState(DEFAULT_FLEET_SCOPE);
  const [selectedId, setSelectedId] = useState('all');
  const [incidents, setIncidents] = useState<ShieldIncident[]>(MOCK_INCIDENTS);

  const matching = useMemo(() => matchingFleet(FLEET, scope), [scope]);
  const visibleThings = useMemo(() => matching.filter((t) => selectedId === 'all' || t.id === selectedId), [matching, selectedId]);
  const visibleIds = useMemo(() => new Set(visibleThings.map((t) => t.id)), [visibleThings]);
  const visibleIncidents = incidents.filter((i) => visibleIds.has(i.equipmentCode));
  const openCount = visibleIncidents.filter((i) => i.status !== 'Resolved').length;
  const criticalCount = visibleIncidents.filter((i) => i.severity === 'Critical').length;
  const investigatingCount = visibleIncidents.filter((i) => i.status === 'Investigating').length;

  return (
    <div id="incident-management-view" className="space-y-6">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-[11px] font-semibold tracking-wider uppercase text-sky-100">People · Machines · Security</span>
        <h2 className="text-xl font-bold">Incident Management</h2>
        <p className="text-sm text-sky-100">Report, investigate and close out safety, machine wellbeing and security incidents.</p>
      </div>

      <FleetFilters scope={scope} onChange={setScope} things={matching} selectedId={selectedId} onSelectId={setSelectedId} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiTile label="Things in scope" value={String(visibleThings.length)} />
        <KpiTile label="Open incidents" value={String(openCount)} tone="warn" />
        <KpiTile label="Critical severity" value={String(criticalCount)} tone="bad" />
        <KpiTile label="Investigating" value={String(investigatingCount)} />
      </div>
      <p className="text-[12px] text-slate-500 dark:text-slate-400">People, machine wellbeing and security · browser-local records · review identities are self-declared in this demo.</p>

      <IncidentManagementSection
        things={matching}
        visibleIncidents={visibleIncidents}
        setIncidents={setIncidents}
        defaultThingId={selectedId !== 'all' ? selectedId : undefined}
        hideHeading
      />
    </div>
  );
};

const KpiTile: React.FC<{ label: string; value: string; tone?: 'warn' | 'bad' }> = ({ label, value, tone }) => {
  const toneClass = tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-800 dark:text-slate-100';
  const boxClass = tone === 'bad'
    ? 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900'
    : tone === 'warn'
      ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900'
      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800';
  return (
    <div className={`border rounded-xl p-4 shadow-xs ${boxClass}`}>
      <div className={`text-xl font-bold ${toneClass}`}>{value}</div>
      <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{label}</div>
    </div>
  );
};
