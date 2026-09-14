import { BadRequestException } from '@nestjs/common';
import { ActivationState } from '../entities/equipment-scenario.entity';

export type ActivationAction = 'propose' | 'activate' | 'pause' | 'resume' | 'deactivate';

/**
 * Every transition the product allows, in one table.
 *
 * Written as data rather than as branches scattered through a service, because the
 * question "can you go from paused straight to deactivated" should have exactly one
 * answer and it should be readable without following code. A state machine expressed
 * as `if` statements in three methods is a state machine with three answers.
 */
const TRANSITIONS: Record<ActivationAction, { from: ActivationState[]; to: ActivationState }> = {
  // The recommendation engine's suggestion, recorded so a client can see what was
  // offered and decide later. Only from nothing — proposing something already
  // running is not a thing anybody means.
  propose: { from: [], to: 'proposed' },
  // From a proposal, from a pause that is over, or from a deactivation somebody has
  // changed their mind about. Turning something back on is ordinary.
  activate: { from: ['proposed', 'paused', 'deactivated'], to: 'active' },
  // Off, with the intent of coming back: maintenance, an alert storm, a sensor being
  // swapped. Distinct from deactivated because the two read differently on a screen
  // and only one of them means "we have stopped using this".
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  // Off for good. Still a row.
  deactivate: { from: ['active', 'paused', 'proposed'], to: 'deactivated' },
};

/** Transitions that must say why. Turning something off without a reason is how a */
/** support call becomes archaeology. */
const REASON_REQUIRED: ActivationAction[] = ['pause', 'deactivate'];

export interface TransitionResult {
  to: ActivationState;
}

/**
 * Decides whether an action is legal from the current state, and says so in terms of
 * what the caller can do next.
 *
 * The error names the state it is in and the states the action would have worked
 * from. "Cannot deactivate" tells somebody nothing; "cannot deactivate a scenario
 * that is already deactivated" tells them they have already done it.
 */
export function transition(
  action: ActivationAction,
  current: ActivationState | null,
  reason: string | null | undefined,
): TransitionResult {
  const rule = TRANSITIONS[action];

  if (current === null) {
    if (action !== 'propose' && action !== 'activate') {
      throw new BadRequestException(
        `Cannot ${action} a scenario that has never been activated on this asset.`,
      );
    }
  } else if (!rule.from.includes(current)) {
    throw new BadRequestException(
      `Cannot ${action} a scenario that is "${current}". `
      + (rule.from.length
        ? `That works from: ${rule.from.join(', ')}.`
        : 'That action only applies to a scenario not yet on this asset.'),
    );
  }

  if (REASON_REQUIRED.includes(action) && !reason?.trim()) {
    throw new BadRequestException(
      `A reason is required to ${action}. It is the first thing anybody asks when an alert stops arriving.`,
    );
  }

  return { to: rule.to };
}

/** For the tests and for anyone reading: the complete transition table. */
export const ACTIVATION_TRANSITIONS = TRANSITIONS;
