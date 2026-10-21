import { critic } from '../rec-frame/critic';
import { BundleView, GroundedAnswer } from '../rec-frame/grounded-answer';

/**
 * The three replay measurements of QEVAL1 §4, as pure functions of a replayed bundle and
 * the frame QREC2's template renderer made from it. No database, so each is tested on
 * a fixture with its answer known.
 */

/** Every string a reader sees in a frame. */
export function frameTexts(f: GroundedAnswer): string[] {
  return [
    f.summary, ...f.observations.map((o) => o.claim), ...f.hypotheses.flatMap((h) => [h.claim, ...h.limitations]),
    ...f.next_steps.flatMap((s) => [s.aim, s.expected_outcome]), ...f.limitations,
  ];
}

export interface Vocabulary {
  /** Every failure mode name, signal and recommendation action in the account's library. */
  names: readonly string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Measurement 1, grounding (§4.1): the critic's checks — refs, numbers traced to the
 * bundle, no future-tense number without a forecast run, aims verbatim — plus the one the
 * critic does not make: no library name in a sentence that the bundle did not carry.
 * A failure names what failed, so a non-zero count points at the template that did it.
 */
export function grounding(frame: GroundedAnswer, bundle: BundleView, vocabulary: Vocabulary): string[] {
  const failed = critic(frame, bundle).map((c) => `critic:${c}`);
  const carried = new Set([
    ...bundle.attribute.modes.flatMap((a) => [a.name, a.failureModeCode, ...a.matchedSignals, ...a.unobservedSignals]),
    ...bundle.attribute.unattributed.map((u) => u.signal),
    ...bundle.detect.entries.map((e) => e.signal),
    ...bundle.candidates.map((c) => c.action),
    ...(bundle.classSlug ? [bundle.classSlug] : []),
  ]);
  const text = frameTexts(frame).join('\n');
  for (const name of new Set(vocabulary.names)) {
    if (!name || carried.has(name)) continue;
    // A name is only a claim if it stands as a word: "temp" inside "temperature" is not one.
    if (new RegExp(`(^|[^\\w])${escape(name)}($|[^\\w])`).test(text)) failed.push(`name_not_in_bundle:${name}`);
  }
  return failed;
}

/**
 * Measurement 2, coverage honesty (D21): wherever the precedent search had no history,
 * the frame says "No history to search", and nothing in it speaks of similar cases or of
 * something having occurred, which is what an empty search would wrongly read as.
 */
export function coverageHonesty(frame: GroundedAnswer, bundle: BundleView): string[] {
  const noHistory = bundle.precedent.modes.some((p) => p.state === 'no_history');
  if (!noHistory) return [];
  const texts = frameTexts(frame);
  const out: string[] = [];
  if (!texts.some((t) => t.includes('No history to search'))) out.push('no_history_not_stated');
  if (texts.some((t) => /\bsimilar\b/i.test(t))) out.push('says_similar');
  if (texts.some((t) => /\boccurred\b/i.test(t))) out.push('says_occurred');
  return out;
}

/** The failure mode the frame's first next step addresses: QREC2's selection, read back off the frame. */
export function selectedMode(frame: GroundedAnswer, bundle: BundleView): string | null {
  const aim = frame.next_steps[0]?.aim;
  if (aim === undefined) return null;
  const selected = bundle.candidates.find((c) => !c.inHand && c.action === aim)
    ?? bundle.candidates.find((c) => c.action === aim);
  return selected?.failureModeCode ?? null;
}

/** Pooled selection tallies. The rate is over labelled moments only, and null over none. */
export interface SelectionTally { labelled: number; agreed: number; disagreed: number; noSelection: number }

export function agreement(t: SelectionTally): { rate: number | null; denominator: number; reason: string | null } {
  return t.labelled
    ? { rate: Math.round((t.agreed / t.labelled) * 10_000) / 10_000, denominator: t.labelled, reason: null }
    : { rate: null, denominator: 0, reason: 'insufficient_history' };
}
