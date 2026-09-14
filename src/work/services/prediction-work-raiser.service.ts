import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { Severity } from '../../common/severity';
import { PredictionTrigger, WorkRaiser } from '../../prediction/work-raiser';
import { WorkOrderEvent } from '../entities/work-order-event.entity';
import { WorkOrder } from '../entities/work-order.entity';

/**
 * The severity at which a warning becomes work.
 *
 * The line between "worth telling somebody" and "worth sending somebody" is a
 * commercial decision rather than a technical one — sending a fitter costs money and
 * a queue nobody can clear is worse than no queue. Set at critical until Things Alive
 * says otherwise (P1-104).
 */
export const RAISE_AT: Severity = Severity.Critical;

/** Nobody is dispatched by a scorer that could not score. */
const UNRAISABLE_CONFIDENCE = 'none';

/**
 * How long an automatically raised job has before it is late.
 *
 * Things Alive: an issue found by manual inspection is resolved within 24 to 48 hours,
 * and that is a target rather than an observation. The outer number is taken, because
 * a due date is a promise and the useful promise is the one that is kept: setting it
 * at 24 would mark half of a normal week's work overdue and teach everybody that the
 * red rows mean nothing.
 */
export const AUTO_JOB_DUE_HOURS = 48;

/**
 * Raising a job from a prediction, with a person still in the loop (task P1-87).
 *
 * Automatic, and deliberately stops one step short of deciding anything: the job is
 * created and left **unassigned**, so it lands in a manager's list and a human says
 * who goes. Auto-assignment would need a rule nobody has given, and guessing one
 * produces jobs sitting with whoever the rule happened to pick.
 *
 * The de-duplication is the part that makes this usable. A failing machine predicts
 * critical on every scoring run — every five minutes, for days — and a job per run is
 * a queue that is ignored within an hour, which is worse than no queue because it
 * looks like coverage. One live job per machine per scenario: the same fault does not
 * raise a second job while the first is unfinished, and a genuinely different scenario
 * on the same machine still does, because "high vibration" and "oil temperature
 * climbing" are two visits.
 */
@Injectable()
export class PredictionWorkRaiser implements WorkRaiser {
  private readonly logger = new Logger(PredictionWorkRaiser.name);

  async raiseFromPrediction(
    m: EntityManager, scope: RequestScope, trigger: PredictionTrigger,
  ): Promise<string | null> {
    if (trigger.severity !== RAISE_AT) return null;

    const repo = m.getRepository(WorkOrder);
    // Checked here for a clear answer and enforced again by a partial unique index,
    // because two scoring runs in flight at once would both read "nothing live" and
    // both insert. The check makes the common case explicable; the index makes it
    // correct.
    const live = await repo.findOne({
      where: [
        {
          tenantId: scope.tenantId, sourceSystem: trigger.sourceSystem,
          externalId: trigger.externalId, raisedForScenario: trigger.clientScenarioSlug,
          origin: 'prediction', status: 'created',
        },
        {
          tenantId: scope.tenantId, sourceSystem: trigger.sourceSystem,
          externalId: trigger.externalId, raisedForScenario: trigger.clientScenarioSlug,
          origin: 'prediction', status: 'in-progress',
        },
      ],
    });
    if (live) return null;

    const [row] = await m.query(
      `INSERT INTO "work_order_counter" ("tenant_id", "next_number") VALUES ($1, 2)
       ON CONFLICT ("tenant_id") DO UPDATE SET "next_number" = "work_order_counter"."next_number" + 1
       RETURNING "next_number"`,
      [scope.tenantId],
    );
    const reference = `WO-${String(Number(row.next_number) - 1).padStart(6, '0')}`;

    const order = await repo.save(repo.create({
      tenantId: scope.tenantId,
      reference,
      sourceSystem: trigger.sourceSystem,
      externalId: trigger.externalId,
      title: `${trigger.clientScenarioSlug}: risk ${Math.round(trigger.riskScore)}`,
      description: 'Raised automatically from a critical prediction. Assign somebody to it.',
      status: 'created',
      // A critical prediction is not an ordinary job, and arriving at 'normal' next to
      // hand-raised routine work is how it gets read as one.
      priority: 'high',
      // Unassigned on purpose. This is the human in the loop.
      assignedToUserId: null,
      predictionId: trigger.predictionId,
      origin: 'prediction',
      raisedForScenario: trigger.clientScenarioSlug,
      // A critical prediction with no date on it is a job nobody is late for. Counted
      // from the moment the reading describes rather than from when the scorer ran, so
      // a backfill scored three days late does not create a job that was already
      // overdue when it appeared.
      dueAt: new Date(trigger.occurredAt.getTime() + AUTO_JOB_DUE_HOURS * 3_600_000),
      startedAt: null,
      endedAt: null,
      resolution: null,
      // Not a person. Attributing this to whoever happened to trigger the scoring run
      // would put a name on a decision they did not make.
      raisedBy: 'system:prediction',
    }));

    const events = m.getRepository(WorkOrderEvent);
    await events.save(events.create({
      tenantId: scope.tenantId, workOrderId: order.id, kind: 'raised',
      fromStatus: null, toStatus: 'created', fromAssignee: null, toAssignee: null,
      note: `Prediction ${trigger.predictionId} scored ${trigger.severity} at `
        + `${trigger.occurredAt.toISOString()}.`,
      actorUserId: 'system:prediction',
    }));

    this.logger.log(
      `Raised ${reference} for ${trigger.externalId} from a ${trigger.severity} prediction.`,
    );
    return order.id;
  }

  /** Exposed so the prediction service can skip the call entirely when unscored. */
  static shouldConsider(severity: Severity, confidence: string): boolean {
    return severity === RAISE_AT && confidence !== UNRAISABLE_CONFIDENCE;
  }
}
