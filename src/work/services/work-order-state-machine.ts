import { BadRequestException } from '@nestjs/common';

/** Where a job is, not who has it. Assignment is a field; see the entity. */
export type WorkOrderStatus = 'open' | 'in-progress' | 'completed' | 'cancelled';

export type WorkOrderAction = 'start' | 'complete' | 'cancel' | 'reopen';

/**
 * Where a job can go from where it is, in one table (task P1-87).
 *
 * The same shape as the inventory and activation state machines, on purpose. Three
 * state machines written three ways is three things to learn, and the third one is
 * always the one somebody reads wrong.
 */
const TRANSITIONS: Record<WorkOrderAction, { from: WorkOrderStatus[]; to: WorkOrderStatus }> = {
  start: { from: ['open'], to: 'in-progress' },
  // Reachable from 'open' as well as 'in-progress'. A fitter who tightens a bolt and
  // closes the job did the work; forcing a start first would only teach everybody to
  // press two buttons, and the timestamps would then describe the buttons rather than
  // the work.
  complete: { from: ['open', 'in-progress'], to: 'completed' },
  cancel: { from: ['open', 'in-progress'], to: 'cancelled' },
  // Neither ending is final. A job completed against the wrong machine, or cancelled
  // by mistake, comes back — and it comes back as 'open' rather than to wherever it
  // was, because "in progress" would be a claim about somebody working right now.
  reopen: { from: ['completed', 'cancelled'], to: 'open' },
};

/**
 * Movements that must say why.
 *
 * Completing needs the most defence. A completed job with no note is indistinguishable
 * from an abandoned one a month later, and the maintenance record — what was actually
 * done to this machine — is the thing the customer keeps. Cancelling and reopening are
 * reversals of somebody's decision, and reversals that nobody explained are how a
 * history stops being usable.
 */
const REASON_REQUIRED: WorkOrderAction[] = ['complete', 'cancel', 'reopen'];

const WHY: Record<string, string> = {
  complete: 'What was done. A completed job with no note is, a month later, '
    + 'indistinguishable from an abandoned one.',
  cancel: 'Why this is not being done.',
  reopen: 'Why this is being reopened.',
};

export function workOrderTransition(
  action: WorkOrderAction,
  current: WorkOrderStatus,
  note: string | null | undefined,
): { to: WorkOrderStatus } {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(current)) {
    throw new BadRequestException(
      `Cannot ${action} a job that is "${current}". That works from: ${rule.from.join(', ')}.`,
    );
  }
  if (REASON_REQUIRED.includes(action) && !note?.trim()) {
    throw new BadRequestException(`A note is required to ${action}. ${WHY[action]}`);
  }
  return { to: rule.to };
}

/** For the tests and for anyone reading: the complete transition table. */
export const WORK_ORDER_TRANSITIONS = TRANSITIONS;
