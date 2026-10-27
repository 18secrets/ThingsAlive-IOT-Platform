import { BundleView, GroundedAnswer } from './grounded-answer';

/** Injection token for the optional model renderer: Gemini when configured (`gemini-frame-model.ts`), else null. */
export const REC_FRAME_MODEL = Symbol('REC_FRAME_MODEL');

/**
 * The seam for a language-model renderer (task QREC2 §6.1, D36).
 *
 * Same input as the templates, same contract out, same critic after. The model is
 * handed the template frame as well as the bundle, so what it is asked to do is
 * rewrite, not compose: it may rephrase string fields and choose a different candidate
 * from this bundle's own list; it may not add an observation, a ref, a number or a step.
 * Anything it returns that the critic refuses is discarded whole.
 *
 * Implemented by `GeminiFrameModel`, on the assistant's Gemini configuration.
 */
export interface FrameModel {
  /** Recorded on the frame row, with `version`: a frame names the model that wrote it (D27). */
  readonly id: string;
  readonly version: string;
  frame(input: { bundle: BundleView; templateFrame: GroundedAnswer }): Promise<unknown>;
}
