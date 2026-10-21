import { BadRequestException } from '@nestjs/common';
import { InventoryState } from '../entities/device-inventory.entity';

export type InventoryAction = 'register' | 'assign' | 'release' | 'retire' | 'return-to-stock' | 'claim' | 'unclaim';

/**
 * Where a device can go from where it is, in one table (task P1-19).
 *
 * The same shape as the activation state machine, on purpose. Two state machines in
 * one codebase written two different ways is two things to learn, and the second one
 * is always the one somebody reads wrong.
 *
 * `claim` and `unclaim` are in the table but do not move the state: fitting a device
 * to a machine and taking it off again both happen while it stays assigned. They are
 * here because they are movements that belong in the history, and because a device
 * that is not assigned to anybody cannot be fitted to anything.
 */
const TRANSITIONS: Record<InventoryAction, { from: InventoryState[]; to: InventoryState | 'same' }> = {
  // Stock arriving. Only from nothing — registering a device that exists is not an
  // error worth raising, it is a no-op, and the service treats it as one.
  register: { from: [], to: 'in-stock' },
  // The commercial act: this device is now that customer's. Only from stock, never
  // from another customer's account — moving a device between customers has to pass
  // through release, so that the release is a decision somebody made and recorded.
  assign: { from: ['in-stock'], to: 'assigned' },
  release: { from: ['assigned'], to: 'in-stock' },
  // Dead, lost or written off. Reachable from either side, because a device fails in
  // a customer's yard as often as it fails on a shelf.
  retire: { from: ['in-stock', 'assigned'], to: 'retired' },
  // Repaired and back in the pool. Retirement is not terminal, but coming back out
  // of it is explicit rather than a side effect of assigning.
  'return-to-stock': { from: ['retired'], to: 'in-stock' },
  claim: { from: ['assigned'], to: 'same' },
  unclaim: { from: ['assigned'], to: 'same' },
};

/**
 * Movements that must say why.
 *
 * Every one of these is somebody losing something: a customer losing a device, a
 * device leaving the pool, an asset losing its logger. "Why did this machine stop
 * reporting in March" is the question, and the answer should not have to be
 * reconstructed from a timestamp.
 */
const REASON_REQUIRED: InventoryAction[] = ['release', 'retire', 'unclaim'];

export interface InventoryTransitionResult {
  to: InventoryState;
}

export function inventoryTransition(
  action: InventoryAction,
  current: InventoryState | null,
  reason: string | null | undefined,
): InventoryTransitionResult {
  const rule = TRANSITIONS[action];

  if (current === null) {
    if (action !== 'register') {
      throw new BadRequestException(
        `Cannot ${action} a device that is not in the inventory. Register it first.`,
      );
    }
  } else if (action === 'register') {
    throw new BadRequestException(`This device is already in the inventory, as "${current}".`);
  } else if (!rule.from.includes(current)) {
    throw new BadRequestException(
      `Cannot ${action} a device that is "${current}". That works from: ${rule.from.join(', ')}.`,
    );
  }

  if (REASON_REQUIRED.includes(action) && !reason?.trim()) {
    throw new BadRequestException(
      `A reason is required to ${action}. Without one, "why did this stop reporting" `
      + 'has to be reconstructed from a timestamp.',
    );
  }

  return { to: rule.to === 'same' ? (current as InventoryState) : rule.to };
}

/** For the tests and for anyone reading: the complete transition table. */
export const INVENTORY_TRANSITIONS = TRANSITIONS;
