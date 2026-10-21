import { BundleView, GroundedAnswer } from './grounded-answer';

/** Injection token for the optional model renderer. Bound to null: there is no client yet (question 8). */
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
 * Only a fake implements it today. A real adapter is its own task, once QSPIKE1b has a
 * runtime to point it at and D08's provider configuration exists.
 */
export interface FrameModel {
  /** Recorded on the frame row, with `version`: a frame names the model that wrote it (D27). */
  readonly id: string;
  readonly version: string;
  frame(input: { bundle: BundleView; templateFrame: GroundedAnswer }): Promise<unknown>;
}
