import { EntityManager } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { Severity } from '../common/severity';

/**
 * How a prediction turns into somebody with a spanner (tasks P1-87, P1-104).
 *
 * An interface and a token, for the same reason the scope resolver is one: prediction
 * must not import the work module. The dependency that matters runs the other way —
 * work orders are about machines and predictions, and a cycle between the two modules
 * is the kind that ends in a half-initialised provider.
 *
 * It is optional. Without a raiser, scoring still scores; nothing raises. That is what
 * lets the prediction suites run without the work tables, and it is also the honest
 * failure mode if the work module is ever pulled out.
 */
export interface PredictionTrigger {
  sourceSystem: string;
  externalId: string;
  predictionId: string;
  clientScenarioSlug: string;
  severity: Severity;
  riskScore: number;
  occurredAt: Date;
}

export interface WorkRaiser {
  /**
   * Raise a job for this prediction, or decide not to.
   *
   * Takes the caller's `EntityManager` so the job is written in the same transaction
   * as the prediction. A prediction that says critical and a job that does not exist
   * is the failure this prevents — and it would be invisible, because both halves
   * look fine on their own.
   *
   * Returns the work order id, or null when nothing was raised: below the threshold,
   * unscored, or already covered by a live job.
   */
  raiseFromPrediction(
    m: EntityManager, scope: RequestScope, trigger: PredictionTrigger,
  ): Promise<string | null>;
}

export const WORK_RAISER = Symbol('ta:work-raiser');
