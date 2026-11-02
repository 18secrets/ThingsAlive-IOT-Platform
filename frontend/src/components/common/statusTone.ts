/**
 * One colour per stage of a thing's life, the same on every page: "Open" was a blue
 * outline on Work Orders, pink on Incidents and red on Alerts (test report COS-1).
 * Status says where something is, not how bad it is — severity keeps the reds — so
 * open is the waiting colour, taken-up amber, done green, dropped grey.
 */
export type StatusTone = 'sky' | 'amber' | 'emerald' | 'slate';

const TONE: Record<string, StatusTone> = {
  open: 'sky', created: 'sky',
  acknowledged: 'amber', 'in-progress': 'amber',
  resolved: 'emerald', completed: 'emerald',
  cancelled: 'slate',
};

export const statusTone = (status: string): StatusTone => TONE[status] ?? 'slate';

export type SeverityTone = 'slate' | 'sky' | 'amber' | 'rose' | 'emerald';

/**
 * One severity scale too: "high" was amber on Alerts, Incidents and Scenarios and rose
 * on Predictions, ThingsCare and the machine page (COS-1). `none` is green only where it
 * is a verdict — a prediction that found nothing — and grey where it is a setting.
 */
export function severityTone(severity: string, opts: { noneIsHealthy?: boolean } = {}): SeverityTone {
  switch (severity) {
    case 'critical': case 'high': return 'rose';
    case 'medium': return 'amber';
    case 'low': return 'sky';
    case 'none': return opts.noneIsHealthy ? 'emerald' : 'slate';
    default: return 'slate';
  }
}
