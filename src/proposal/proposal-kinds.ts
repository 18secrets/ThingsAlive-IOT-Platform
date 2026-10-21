/**
 * The closed vocabulary of the proposal substrate (task QGEN1, D25–D28), and every
 * number it runs on, named once.
 */

/**
 * What can be proposed. `prediction` is not here and never will be (D26): no numeric
 * value about the future may originate from a language model, so there is no emitter
 * for one. The table's CHECK says the same thing to anything that bypasses this type.
 */
export const PROPOSAL_KINDS = ['kpi', 'workflow'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** Compile-time half of "prediction is not a kind": this line stops compiling if it becomes one. */
export const PREDICTION_IS_NOT_A_KIND: 'prediction' extends ProposalKind ? never : true = true;

/** Whether a kind fires. A kind that fires is replayed before anyone sees it (D28); one that does not is `not_applicable`. */
export const FIRES: Record<ProposalKind, boolean> = { kpi: false, workflow: true };

export type ProposalScope = 'tenant' | 'class';

export type ProposalStatus =
  | 'proposed' | 'compile_refused' | 'compiled' | 'gate_refused' | 'draft_ready'
  | 'approved' | 'rejected' | 'materialised' | 'expired';

export type GateOutcome = 'pass' | 'refuse' | 'insufficient_history' | 'not_applicable';
export type ReplayOutcome = Exclude<GateOutcome, 'not_applicable'>;

/** D14's hot window: the only full-resolution data in the database. Replay never reads the archive. */
export const REPLAY_WINDOW_DAYS = 90;

/** D28, both numbers decided: fewer than either, and the replay cannot say anything. */
export const MIN_HISTORY_DAYS = 14;
export const MIN_HISTORY_READINGS = 200;

/**
 * Question 6: no duration is decided. Provisional, and the same lifetime the onboarding
 * assistant's proposals have (`PROPOSAL_LIFETIME_MS`, QCHAT2) so the console has one
 * meaning of "this proposal expired". The version recheck at approval, not this, is what
 * catches the dangerous case.
 */
export const PROPOSAL_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Question 9: no decision names a cap. Provisional, to be replaced once Deepak has the
 * measured cost per machine this task reports. A proposal covering more machines is
 * refused at the gate rather than replayed in part.
 */
export const REPLAY_MACHINE_CAP = 25;

/** How many firing windows a replay run keeps in full; the count is always complete. */
export const FIRES_DETAIL_LIMIT = 50;

/**
 * Question 1: D28 says `pass` is "fire count within bounds" and gives no bound, and
 * START-HERE forbids replacing a missing threshold with a made-up one. So the maximum
 * fires per machine over the replay window is configuration with no default:
 * `PROPOSAL_REPLAY_MAX_FIRES`. Until it is set, a replay with enough history is
 * refused with that reason — the safe direction, since a refusal cannot be approved —
 * and its fire count is still recorded for whoever names the number.
 */
export function replayMaxFires(): number | null {
  const raw = process.env.PROPOSAL_REPLAY_MAX_FIRES;
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
