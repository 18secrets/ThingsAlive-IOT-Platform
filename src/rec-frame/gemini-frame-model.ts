import { AssistantModel, GeminiModel, geminiConfigFrom } from '../assistant/assistant-model';
import { FrameModel } from './frame-model';
import { BundleView, GroundedAnswer } from './grounded-answer';

/**
 * The instruction, versioned with the adapter: a change to it is a new `version`, so a
 * frame row says which wording of the rules its prose was written under (D27).
 */
export const GEMINI_FRAME_VERSION = 'rec-frame-gemini@1';

const SYSTEM = [
  'You rewrite a maintenance recommendation so a site supervisor can read it quickly.',
  'You are given EVIDENCE (what the platform found) and FRAME (the same facts already written as a',
  'GroundedAnswer JSON). Return the FRAME as JSON with the same structure, rewritten in plain, direct English.',
  '',
  'Rules. A reply that breaks any of them is discarded and the original FRAME is shown instead.',
  '1. Change only these text fields: summary, observations[].claim, hypotheses[].claim,',
  '   hypotheses[].limitations[], next_steps[].expected_outcome, limitations[].',
  '2. Keep every other field exactly as given, including every evidence_refs entry, status, missing_inputs,',
  '   citations and the order of next_steps. Do not add, remove or reorder any item in any list.',
  '3. next_steps[].aim is the library action: copy it exactly, character for character.',
  '4. Use no number, date, time or quantity that is not already written in the FRAME, and write any you keep',
  '   exactly as the FRAME writes it.',
  '5. Never state a probability or confidence: no "%", "likely", "probably", "chance" or "confident".',
  '6. Say nothing the FRAME does not say. No new causes, risks, advice or reassurance.',
  '7. Reply with the JSON object only: no code fences, no commentary.',
].join('\n');

/**
 * Gemini as the frame model (task QREC2 §6.1, D36): the template frame, rephrased.
 *
 * The same Gemini the assistant uses — `ASSISTANT_MODEL`, by Vertex AI or API key — so
 * there is one provider configuration and one place it fails. It is asked to rewrite, not
 * compose: it is handed the template frame with the bundle, and the critic holds whatever
 * it returns to that (no new number, ref, step or observation). It decides nothing about
 * the machine; the recommendation is the engine's, and the template frame is always
 * stored beside it and served whenever this one is refused. On only when
 * REC_FRAME_MODEL_ENABLED is true (RecFrameService).
 */
export class GeminiFrameModel implements FrameModel {
  readonly id: string;
  readonly version = GEMINI_FRAME_VERSION;

  constructor(private readonly model: AssistantModel) {
    this.id = model.name;
  }

  async frame(input: { bundle: BundleView; templateFrame: GroundedAnswer }): Promise<unknown> {
    const reply = await this.model.generate({
      system: SYSTEM,
      turns: [{
        role: 'user',
        text: `EVIDENCE:\n${JSON.stringify(input.bundle)}\n\nFRAME:\n${JSON.stringify(input.templateFrame)}`,
      }],
      tools: [],
    });
    if (!reply.text) throw new Error('the frame model returned no text');
    return parseJsonObject(reply.text);
  }
}

/**
 * The reply as a JSON object. Models fence JSON in ``` however they are told not to, so a
 * single fence is unwrapped; anything else that is not one JSON object is an error, which
 * the frame service records as `model_error` and serves the template instead.
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  const unfenced = text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    throw new Error('the frame model did not return JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the frame model did not return a JSON object');
  return parsed as Record<string, unknown>;
}

/** Bound when the assistant's Gemini is configured; null otherwise, which is the seam's own "no model". */
export function frameModelFromEnv(env: Record<string, string | undefined>): FrameModel | null {
  const config = geminiConfigFrom(env);
  return config ? new GeminiFrameModel(new GeminiModel(config)) : null;
}
