import { createHash } from 'crypto';
import { RecEvidenceBundle } from '../rec-engine/rec-evidence-bundle.entity';

/** GroundedAnswerV1 (`docs/ai/contracts/grounded-answer.v1.schema.json`), as this task fills it. */
export interface GroundedAnswer {
  answer_id: string;
  context_id: string;
  status: 'answered' | 'partial' | 'needs_input' | 'insufficient_evidence' | 'unavailable';
  summary: string;
  observations: { claim: string; evidence_refs: string[] }[];
  hypotheses: { claim: string; evidence_refs: string[]; limitations: string[] }[];
  next_steps: { aim: string; expected_outcome: string; required_capability: string; simulation_available: boolean }[];
  citations: unknown[];
  missing_inputs: string[];
  as_of: string;
  limitations: string[];
  proposal_ids?: string[];
}

/**
 * The bundle's JSON sections, typed only as far as the frame reads them. QREC1 writes
 * them; the frame describes them and never looks anything up afresh (§1).
 */
export interface BundleView {
  id: string;
  asOf: string;
  status: RecEvidenceBundle['status'];
  reason: RecEvidenceBundle['reason'];
  outcome: RecEvidenceBundle['outcome'];
  classSlug: string | null;
  detect: {
    entries: {
      signal: string; state: string; reason: string | null; lastReadingAt: string | null;
      sources: { kind: string; ref?: string; trigger?: string; reason?: string }[];
    }[];
    coverage: { expected: string[]; observed: string[]; sources: Record<string, string> };
    unattributableAlerts: { ref: string; trigger: string }[];
  };
  attribute: {
    modes: { failureModeCode: string; name: string; status: string; matchedSignals: string[]; unobservedSignals: string[] }[];
    unattributed: { signal: string; refs: string[] }[];
  };
  precedent: {
    modes: {
      failureModeCode: string; state: string;
      alertEvents: { id: string }[]; workOrders: { id: string; observedHours: number | null }[]; serviceRecords: { id: string }[];
    }[];
    coverage: { sources: Record<string, { rows: number }>; period: { from: string | null; to: string } };
  };
  gap: { noLibraryRecommendation: string[]; alreadyInHand: unknown[]; unobserved: { failureModeCode: string; signals: string[] }[] };
  cost: {
    lines: { recommendationId: string; line: string; result: { status: string; reasons: string[]; value: number | null; unit: string | null; parameter_set_version: string | null; limitations: string[] } }[];
    missingParameters: string[];
  };
  candidates: {
    recommendationId: string; failureModeCode: string; action: string; urgency: string;
    estimatedHours: number | null; inHand: boolean; inHandWorkOrderIds: string[];
  }[];
}

/** The bundle as plain JSON: what the frame and the critic both read, so they cannot see different things. */
export function bundleView(b: RecEvidenceBundle): BundleView {
  return JSON.parse(JSON.stringify({
    id: b.id, asOf: b.asOf.toISOString(), status: b.status, reason: b.reason, outcome: b.outcome, classSlug: b.classSlug,
    detect: b.detect, attribute: b.attribute, precedent: b.precedent, gap: b.gap, cost: b.cost, candidates: b.candidates,
  })) as BundleView;
}

/** A uuid-shaped id derived from what was rendered, so the same rendering is always the same answer_id. */
export function frameId(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
