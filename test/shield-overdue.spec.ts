import { ShieldEvidenceRecord } from '../src/shield/shield-evidence-record.entity';
import { categoryStatus } from '../src/shield/shield.service';

const DAY = 86_400_000;
const NOW = new Date('2026-11-11T12:00:00Z');

/**
 * ThingsShield, test report MIN-4: a check that failed and is also past its due date read
 * "Action required", and the tester expected "Overdue". Decided 11 Nov: the status stays
 * "Action required" — a failed check is the more urgent fact — and how far past due it is
 * travels beside it, so the screen can say both.
 */
describe('a ThingsShield category past its due date', () => {
  const record = (over: Partial<ShieldEvidenceRecord>): ShieldEvidenceRecord => ({
    id: 'r1', tenantId: 'acme', sourceSystem: 'src', externalId: 'DG-1', category: 'compliance', title: 'Annual check',
    result: 'passed', performedAt: new Date(NOW.getTime() - 400 * DAY), dueAt: null, ownerUserId: null, ownerName: null,
    reference: null, findings: null, recordedBy: 'u', createdAt: new Date(NOW.getTime() - 400 * DAY), supersedesId: null,
    ...over,
  } as ShieldEvidenceRecord);

  it('failed and 12 days past due: still Action required, and 12 days overdue beside it', () => {
    const s = categoryStatus([record({ result: 'failed', dueAt: new Date(NOW.getTime() - 12 * DAY) })], 30, NOW);
    expect(s.status).toBe('action_required');
    expect(s.overdueDays).toBe(12);
  });

  it('passed and past due: Overdue, with its days', () => {
    const s = categoryStatus([record({ dueAt: new Date(NOW.getTime() - 3 * DAY - 3_600_000) })], 30, NOW);
    expect(s).toMatchObject({ status: 'overdue', overdueDays: 3 });
  });

  it('a few hours past due counts as one day, not zero', () => {
    expect(categoryStatus([record({ dueAt: new Date(NOW.getTime() - 2 * 3_600_000) })], 30, NOW).overdueDays).toBe(1);
  });

  it('not past due, or no due date: nothing said', () => {
    expect(categoryStatus([record({ result: 'failed', dueAt: new Date(NOW.getTime() + 5 * DAY) })], 30, NOW))
      .not.toHaveProperty('overdueDays');
    expect(categoryStatus([record({ result: 'failed' })], 30, NOW)).not.toHaveProperty('overdueDays');
  });
});
