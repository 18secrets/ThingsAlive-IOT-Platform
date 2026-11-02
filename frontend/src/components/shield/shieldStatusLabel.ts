import type { TFunction } from 'i18next';
import type { ShieldEvidence, ShieldStatus } from '../../lib/api';

/**
 * A failed check reads "Action required" even when it is also past its date — the
 * failure is what to act on first (shield.service.ts categoryStatus). Saying only that
 * made a past-due failed Compliance item look like it had escaped the due-date rule a
 * past-due passed Safety item was under (test report MIN-4); it says both now.
 */
export function shieldStatusLabel(
  t: TFunction, cell: { status: ShieldStatus; record: ShieldEvidence | null }, now: Date = new Date(),
): string {
  const label = t(`status.${cell.status}`);
  const pastDue = !!cell.record?.dueAt && new Date(cell.record.dueAt).getTime() < now.getTime();
  return cell.status === 'action_required' && pastDue ? `${label} · ${t('status.alsoOverdue')}` : label;
}
