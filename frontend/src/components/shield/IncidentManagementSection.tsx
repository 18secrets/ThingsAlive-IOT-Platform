import React, { useState } from 'react';
import { Download, Plus, ShieldAlert } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { FleetThing, findThing } from '../../data/fleetMockData';
import { ShieldIncident } from '../../data/shieldMockData';
import { IncidentCard, IncidentForm, IncidentFormValues } from './IncidentRecord';
import { Modal } from '../common/Modal';

function exportCsv(incidents: ShieldIncident[]) {
  const header = ['id', 'equipmentCode', 'equipmentName', 'title', 'category', 'severity', 'status', 'owner', 'workOrderStatus', 'createdAt'];
  const rows = incidents.map((i) => header.map((k) => JSON.stringify((i as unknown as Record<string, string>)[k] ?? '')).join(','));
  const csv = [header.join(','), ...rows].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'thingsshield-incidents.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export const IncidentManagementSection: React.FC<{
  things: FleetThing[];
  visibleIncidents: ShieldIncident[];
  setIncidents: React.Dispatch<React.SetStateAction<ShieldIncident[]>>;
  defaultThingId?: string;
  /** Omit the "Incident Management" heading — the standalone Incident
   *  Management page already says this in its own hero banner just above. */
  hideHeading?: boolean;
}> = ({ things, visibleIncidents, setIncidents, defaultThingId, hideHeading }) => {
  const navigate = useNavigate();
  const [editing, setEditing] = useState<ShieldIncident | 'new' | null>(null);

  function save(values: IncidentFormValues) {
    const thing = findThing(values.equipmentCode);
    if (editing && editing !== 'new') {
      setIncidents((current) => current.map((i) => (i.id === editing.id ? { ...i, ...values, equipmentName: thing?.name ?? i.equipmentName } : i)));
    } else {
      setIncidents((current) => [
        { ...values, id: crypto.randomUUID(), equipmentName: thing?.name ?? values.equipmentCode, workOrderStatus: 'Open', note: 'Illustrative incident for workflow demonstration; no actual event asserted.', createdAt: new Date().toISOString() },
        ...current,
      ]);
    }
    setEditing(null);
  }

  return (
    <div className="space-y-4">
      {!hideHeading && (
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Incident Management</h3>
          <p className="text-[12px] text-slate-500 dark:text-slate-400">People, machine wellbeing and security · browser-local records · review identities are self-declared in this demo.</p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button onClick={() => setEditing('new')} className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">
          <Plus className="w-4 h-4" /> Report incident
        </button>
        <button onClick={() => exportCsv(visibleIncidents)} className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-sky-300">
          <Download className="w-4 h-4" /> Export filtered records
        </button>
      </div>

      <Modal
        isOpen={editing !== null}
        onClose={() => setEditing(null)}
        title={editing !== 'new' && editing ? 'Edit incident' : 'Report incident'}
        maxWidth="max-w-lg"
      >
        <IncidentForm
          things={things}
          initial={editing !== 'new' ? editing ?? undefined : undefined}
          defaultThingId={defaultThingId}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      </Modal>

      {visibleIncidents.length === 0 ? (
        <div className="py-10 text-center text-slate-400 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col items-center gap-2">
          <ShieldAlert className="w-6 h-6" />
          No incidents for this selection.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {visibleIncidents.map((incident) => (
            <IncidentCard key={incident.id} incident={incident} onEdit={() => setEditing(incident)} onViewWorkOrder={() => navigate('/work-orders')} />
          ))}
        </div>
      )}
    </div>
  );
};
