// UI-only mock data for the client-facing ThingsShield page — no backend yet.
// Mirrors clientOpsMockData.ts's shape: a handful of curated incident rows
// against real fleetMockData.ts ids, plus a deterministic per-machine evidence
// record set so the page doesn't need a live inspection/incident system to
// demonstrate the workflow.

import { FleetThing } from './fleetMockData';

export type ShieldCategory = 'compliance' | 'regulation' | 'safety' | 'security';
export type ShieldResult = 'Passed' | 'Failed' | 'Attention';
export type ShieldStatus = 'Current' | 'Due soon' | 'Overdue' | 'Action required';

export const SHIELD_CATEGORIES: ShieldCategory[] = ['compliance', 'regulation', 'safety', 'security'];

export const CATEGORY_LABELS: Record<ShieldCategory, string> = {
  compliance: 'Compliance',
  regulation: 'Regulation',
  safety: 'Safety',
  security: 'Security',
};

interface CategoryTemplate { title: string; owner: string; referencePrefix: string; note: string }

const CATEGORY_TEMPLATE: Record<ShieldCategory, CategoryTemplate> = {
  compliance: { title: 'Periodic equipment inspection', owner: 'Maintenance lead (sample)', referencePrefix: 'SAMPLE-INSPECTION', note: 'Illustrative checklist reference only; no real certificate or test evidence attached.' },
  regulation: { title: 'Applicable requirements review', owner: 'Maintenance lead (sample)', referencePrefix: 'SAMPLE-APPLICABILITY', note: 'Illustrative checklist reference only; no real certificate or test evidence attached.' },
  safety: { title: 'Guard / isolation inspection', owner: 'Maintenance lead (sample)', referencePrefix: 'SAMPLE-SAFETY-CHECK', note: 'Sample inspection: guard latch requires adjustment. No real interlock tested.' },
  security: { title: 'Controller access review', owner: 'IT/OT lead (sample)', referencePrefix: 'SAMPLE-ACCESS-LOG', note: 'Illustrative checklist reference only; no real certificate or test evidence attached.' },
};

export interface ShieldEvidenceRecord {
  id: string;
  thingId: string;
  category: ShieldCategory;
  title: string;
  result: ShieldResult;
  status: ShieldStatus;
  dueDate: string;
  owner: string;
  reference: string;
  note: string;
  createdAt: string;
  /** Set once someone has used "Add evidence record" / "Edit evidence" — the seeded records above don't carry these. */
  findings?: string;
  reviewer?: string;
  recordedBy?: string;
}

export const REGULATION_APPLICABILITY = {
  jurisdiction: 'India',
  status: 'To be confirmed',
  label: 'Sample applicability',
  description: 'Sample applicability register: site inspection, maintenance procedure, isolation and access review. Confirm local requirements before operational use.',
};

// One evidence record per category. Regulation is always "due soon" — the
// site-applicability register (REGULATION_APPLICABILITY) is a placeholder
// every tenant still has to confirm, never a pass/fail result. Compliance,
// Safety and Security are seeded per machine so roughly one in five comes
// back overdue or failed, which is what drives this mock's fleet-wide
// "Overdue/failed" KPI.
export function evidenceRecordsFor(thing: FleetThing): ShieldEvidenceRecord[] {
  const seed = Number(thing.id.replace(/\D/g, '')) || 1;
  return SHIELD_CATEGORIES.map((category, i) => {
    const tmpl = CATEGORY_TEMPLATE[category];
    const reference = `${tmpl.referencePrefix}-${thing.id}`;
    const dueDate = ['2026-10-02', '2026-10-15', '2026-11-04', '2026-11-04'][i];
    const createdAt = '2026-09-05T09:00:00+05:30';

    if (category === 'regulation') {
      return {
        id: `${thing.id}-regulation`, thingId: thing.id, category, title: tmpl.title,
        result: 'Attention', status: 'Due soon', dueDate, owner: tmpl.owner, reference,
        note: tmpl.note, createdAt,
      };
    }

    const roll = (seed + i * 37) % 100;
    const result: ShieldResult = roll < 10 ? 'Failed' : 'Passed';
    const status: ShieldStatus = roll < 10 ? 'Action required' : roll < 20 ? 'Overdue' : 'Current';
    return {
      id: `${thing.id}-${category}`, thingId: thing.id, category, title: tmpl.title, result, status,
      dueDate, owner: tmpl.owner, reference,
      note: status === 'Action required' ? 'Sample inspection: guard latch requires adjustment. No real interlock tested.' : tmpl.note,
      createdAt,
    };
  });
}

export type IncidentCategory = 'Human safety' | 'Machine wellbeing' | 'Security';
export type IncidentSeverity = 'Critical' | 'Warning' | 'Info';
export type IncidentStatus = 'Open' | 'Investigating' | 'Resolved';

export interface ShieldIncident {
  id: string;
  equipmentCode: string;
  equipmentName: string;
  title: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  status: IncidentStatus;
  owner: string;
  investigation?: string;
  correctiveAction?: string;
  closureEvidence?: string;
  independentReviewer?: string;
  recordedBy?: string;
  workOrderStatus: string;
  note: string;
  createdAt: string;
}

// A handful of curated incidents against real fleet ids — same shape as
// MOCK_WORK_ORDERS, not one row per machine.
export const MOCK_INCIDENTS: ShieldIncident[] = [
  { id: 'inc-1', equipmentCode: '4100460', equipmentName: 'Diesel Generator Set 320 kVA', title: 'Near miss during access inspection', category: 'Human safety', severity: 'Critical', status: 'Investigating', owner: 'EHS lead (sample)', workOrderStatus: 'Open', note: 'Illustrative incident for workflow demonstration; no actual event asserted.', createdAt: '2026-09-23T11:00:00+05:30' },
  { id: 'inc-2', equipmentCode: '4600055', equipmentName: 'Pick & Carry Crane PIXEF 215', title: 'Abnormal vibration inspection', category: 'Machine wellbeing', severity: 'Warning', status: 'Investigating', owner: 'Maintenance lead (sample)', workOrderStatus: 'In Progress', note: 'Illustrative incident for workflow demonstration; no actual event asserted.', createdAt: '2026-09-22T09:30:00+05:30' },
  { id: 'inc-3', equipmentCode: '3100357', equipmentName: 'CONCRETE PUMP BSA 2110HPD', title: 'Unrecognised controller login', category: 'Security', severity: 'Warning', status: 'Investigating', owner: 'IT/OT lead (sample)', workOrderStatus: 'Awaiting Approval', note: 'Illustrative incident for workflow demonstration; no actual event asserted.', createdAt: '2026-09-21T15:00:00+05:30' },
];

export interface ShieldSummary { evidenceRecords: number; currentPassed: number; overdueFailed: number; dueSoon: number; openIncidents: number }

export function shieldSummaryFor(thing: FleetThing, incidents: ShieldIncident[]): ShieldSummary {
  const records = evidenceRecordsFor(thing);
  return {
    evidenceRecords: records.length,
    currentPassed: records.filter((r) => r.status === 'Current').length,
    overdueFailed: records.filter((r) => r.status === 'Overdue' || r.status === 'Action required').length,
    dueSoon: records.filter((r) => r.status === 'Due soon').length,
    openIncidents: incidents.filter((inc) => inc.equipmentCode === thing.id && inc.status !== 'Resolved').length,
  };
}
