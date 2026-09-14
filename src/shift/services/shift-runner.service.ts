import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AlertService } from '../../alert/services/alert.service';
import { RequestScope } from '../../auth/types/request-scope';
import { LegacyTelemetryReader } from '../../legacy/legacy-telemetry.reader';
import { PredictionService } from '../../prediction/services/prediction.service';
import { TelemetryService } from '../../telemetry/telemetry.service';
import { ChainService } from '../../intelligence/services/chain.service';
import { WindowChain } from '../../alert/services/alert-rules';
import { DeviceHealthService } from '../../device-health/services/device-health.service';
import { assessLink } from '../../device-health/services/link-health';
import { computeDutyCycle } from '../../utilization/services/duty-cycle';
import { UtilizationService } from '../../utilization/services/utilization.service';
import { runningStatusFor } from './running-status';
import { withTenantId } from '../../scope/tenant-session';
import { ShiftRun } from '../entities/shift-run.entity';
import { tryTakePassLock } from './pass-lock';
import { OwedWindow, ShiftService } from './shift.service';

export interface RunOutcome {
  shiftId: string;
  tenantId: string;
  externalId: string;
  localDate: string;
  status: 'scored' | 'nothing-to-score' | 'not-running' | 'failed';
  readings?: number;
  predictions?: number;
  raised?: number;
  /** Alert rules that fired for this window. */
  alerts?: number;
  detail?: string;
}

export interface RunSummary {
  considered: number;
  scored: number;
  skipped: number;
  /** Windows where the machine reported that it never ran. */
  idle: number;
  failed: number;
  /** Shifts rewound because readings turned up for a window already scored. */
  rewound: number;
  outcomes: RunOutcome[];
}

/**
 * The pass that turns a finished shift into a prediction (task P1-111).
 *
 * Four steps per window and the order is the whole design: pull the readings for the
 * window, ingest them, score the machine, move the watermark. The watermark moves
 * last and only on success, so a window that failed is still owed and comes round
 * again — a watermark advanced on failure turns a bad afternoon into a permanent hole
 * in a machine's history that nothing goes back for.
 *
 * It runs as nobody. There is no request behind it and no person to attribute the work
 * to, so the scope it builds is a synthetic one for the account being scored, and the
 * one capability it carries is the one it uses.
 */
@Injectable()
export class ShiftRunner {
  private readonly logger = new Logger(ShiftRunner.name);

  constructor(
    private readonly ds: DataSource,
    private readonly shifts: ShiftService,
    private readonly reader: LegacyTelemetryReader,
    private readonly telemetry: TelemetryService,
    private readonly predictions: PredictionService,
    private readonly alerts: AlertService,
    private readonly utilization: UtilizationService,
    private readonly deviceHealth: DeviceHealthService,
    private readonly chains: ChainService,
  ) {}

  /**
   * One pass, and only if nobody else is already making one.
   *
   * Two instances running the same pass would both read the same watermark and score
   * the same shift. Nothing would be corrupted — a prediction upserts and a live
   * automatic job is refused by a unique index — but it doubles the work and halves
   * the sense the logs make at exactly the moment somebody is reading them to find out
   * why a machine was not scored.
   *
   * A tick that arrives mid-pass is dropped rather than queued: the work it would do
   * is the work already in progress, and the next tick finds whatever is left.
   */
  async runExclusively(now = new Date()): Promise<RunSummary | null> {
    const lock = await tryTakePassLock(this.ds);
    if (!lock) {
      this.logger.debug('Another instance is mid-pass. Skipping this tick.');
      return null;
    }
    try {
      return await this.run(now);
    } finally {
      await lock.release();
    }
  }

  async run(now = new Date()): Promise<RunSummary> {
    // Sweep first, score second. A logger that has been off the network pushes its
    // buffer stamped with its own clock, so those readings belong to windows that have
    // already been scored and passed; sweeping afterwards would mean every late push
    // waits a whole extra pass before anybody looks at it.
    const rewound = await this.sweepLateArrivals(now);

    const owed = await this.shifts.owed(now);
    const summary: RunSummary = {
      considered: owed.length, scored: 0, skipped: 0, idle: 0, failed: 0, rewound, outcomes: [],
    };
    if (owed.length === 0) return summary;

    if (!this.reader.connected) {
      // Loud, and not a failure of any particular shift. Every window stays owed, so
      // the moment a connection exists the backlog is scored rather than lost.
      this.logger.warn(
        `${owed.length} shift window(s) are owed, and there is no connection to the `
        + 'existing platform to read them from. Nothing scored; nothing lost.',
      );
      summary.skipped = owed.length;
      summary.outcomes = owed.map((w) => this.outcome(w, 'nothing-to-score', 'no connection'));
      return summary;
    }

    for (const window of owed) {
      const startedAt = Date.now();
      const outcome = await this.one(window);
      await this.record(window, outcome, Date.now() - startedAt);
      summary.outcomes.push(outcome);
      if (outcome.status === 'scored') summary.scored += 1;
      else if (outcome.status === 'failed') summary.failed += 1;
      else if (outcome.status === 'not-running') summary.idle += 1;
      else summary.skipped += 1;
    }
    return summary;
  }

  /**
   * Put back any window whose readings turned up after it was scored.
   *
   * The loggers hold up to two days off the network, so this is the ordinary case. A
   * prediction built from the third of a shift that happened to be online is not
   * wrong in a way anybody can see — it is a confident answer about a machine, made
   * from a fraction of the evidence, with nothing to say so.
   *
   * Re-scoring appends: a prediction is keyed by the moment of its newest reading, so
   * the window ends up carrying the thin answer and then the fuller one. Both were
   * true when made, and the newest is the one that counts.
   */
  private async sweepLateArrivals(now: Date): Promise<number> {
    if (!this.reader.connected) return 0;
    let rewound = 0;

    for (const shift of await this.shifts.activeShifts()) {
      try {
        const late = await this.reader.lateArrivals({
          tenantId: shift.tenantId,
          sourceSystem: shift.sourceSystem,
          externalId: shift.externalId,
          since: shift.arrivalsThrough,
          upTo: now,
        });
        if (!late) continue;

        const didRewind = await this.shifts.rewindForLateArrivals(
          shift.tenantId, shift.id, late.earliestReading, late.seenThrough,
        );
        if (didRewind) {
          rewound += 1;
          this.logger.log(
            `${late.count} reading(s) arrived late for ${shift.externalId}, oldest `
            + `${late.earliestReading.toISOString()}. Re-scoring from there.`,
          );
        }
      } catch (error) {
        // A sweep that fails leaves both watermarks where they were, so the same late
        // readings are found again next pass. Nothing is lost by moving on.
        this.logger.error(
          `Could not sweep late arrivals for ${shift.externalId}: ${(error as Error).message}`,
        );
      }
    }
    return rewound;
  }

  private async one(window: OwedWindow): Promise<RunOutcome> {
    try {
      const pull = await this.reader.pull({
        tenantId: window.tenantId,
        sourceSystem: window.sourceSystem,
        externalId: window.externalId,
        from: window.start,
        to: window.end,
      });

      if (!pull.envelope) {
        // Silence is still worth evaluating, and this is the one case where that
        // matters most: a machine that was meant to be running and said nothing looks
        // exactly like a machine that was switched off, unless somebody has asked to
        // be told. A `no-telemetry` rule is that request, and it is the client's to
        // make rather than ours to assume.
        const silent = await this.evaluateAlerts(window, [], []);

        // A shift with no telemetry is still a row in the utilization report, and it
        // is the most important one in it. Recording only the shifts that reported
        // would mean the fleet average is computed over the machines that were
        // online — survivorship bias with a chart on top, where the machines nobody
        // can see are exactly the ones missing from the report about them.
        await this.recordUtilization(window, []);
        await this.recordLinkHealth(window, []);

        // Otherwise a shift that produced no readings is a fact about the shift, not
        // a failure to be retried forever: coming back to the same empty window on
        // every pass would stall everything behind it. The watermark moves.
        await this.shifts.markScored(window.tenantId, window.shiftId, window.end);
        return { ...this.outcome(window, 'nothing-to-score', pull.reason), alerts: silent };
      }

      // The IMEI rides along: duty cycle and the alert rules do not care which logger
      // a reading came from, but the link check is per device and cannot be assembled
      // without it.
      const readings = pull.envelope.readings.map((r) => ({
        imei: r.imei, signal: r.signal, value: r.value, unit: r.unit ?? null,
        sourceTimestamp: r.sourceTimestamp,
      }));

      // The machine's own account of whether it ran. A shift where the logger reported
      // all day and the engine never turned over is a shift's worth of readings that
      // look like telemetry and describe nothing — cold, still, unloaded — and scoring
      // them against a baseline built from a working machine produces a confident
      // answer about a machine that was not there.
      if (runningStatusFor(readings) === 'not-running') {
        // Ingested anyway: the readings are true, they belong to the history, and the
        // question of whether a baseline should be built from idle periods is a
        // separate one (P1-123) that this must not quietly decide.
        await this.telemetry.ingest(pull.envelope);
        // The shift the machine slept through is the one the utilization report exists
        // to show. Skipping it here would leave a hole that reads as a gap in the data
        // rather than as a machine that was paid for and not used.
        await this.recordUtilization(window, readings);
        await this.recordLinkHealth(window, readings);
        await this.shifts.markScored(window.tenantId, window.shiftId, window.end);
        return { ...this.outcome(window, 'not-running', 'engine-never-ran'), readings: readings.length };
      }

      const ingested = await this.telemetry.ingest(pull.envelope);
      const scope = this.runnerScope(window.tenantId);
      const result = await this.predictions.scoreAsset(
        scope, { sourceSystem: window.sourceSystem, externalId: window.externalId }, window.end,
      );

      // The physical chains, run on the readings already in hand. A chain rule needs
      // this to have anything to say; every other rule is unaffected by its absence.
      const chains = await this.diagnoseChains(window, readings);

      const alerts = await this.evaluateAlerts(
        window,
        readings,
        result.written.map((p) => ({
          clientScenarioSlug: p.clientScenarioSlug,
          severity: p.severity,
          riskScore: p.riskScore,
          predictionId: p.id,
          confidence: p.confidence,
        })),
        chains,
      );

      await this.recordUtilization(window, readings);
      await this.recordLinkHealth(window, readings);

      // Last, and only now. Everything above either happened or threw.
      await this.shifts.markScored(window.tenantId, window.shiftId, window.end);

      return {
        ...this.outcome(window, 'scored'),
        readings: ingested.accepted,
        predictions: result.written.length,
        raised: result.raised.length,
        alerts,
      };
    } catch (error) {
      // The watermark has not moved, so this window is still owed and will be taken
      // again. Logged rather than rethrown: one machine failing must not stop the
      // pass, or a single bad asset holds up every other customer's scoring.
      const detail = (error as Error).message;
      this.logger.error(
        `Shift ${window.shiftName} on ${window.externalId} (${window.localDate}) failed `
        + `and is still owed: ${detail}`,
      );
      return this.outcome(window, 'failed', detail);
    }
  }

  /**
   * Write down what happened to this window, whatever happened.
   *
   * Every outcome, not only the failures. A window skipped because the machine never
   * ran is the explanation somebody needs; if only failures were kept, the absence of
   * a row would mean either "it worked" or "nothing happened", and those are the two
   * answers that most need telling apart.
   *
   * Never fatal, and deliberately so: losing a scored prediction because its receipt
   * could not be filed would be the wrong way round.
   */
  private async record(
    window: OwedWindow, outcome: RunOutcome, durationMs: number,
  ): Promise<void> {
    try {
      await withTenantId(this.ds, window.tenantId, (m) => {
        const repo = m.getRepository(ShiftRun);
        return repo.save(repo.create({
          tenantId: window.tenantId,
          shiftId: window.shiftId,
          shiftName: window.shiftName,
          sourceSystem: window.sourceSystem,
          externalId: window.externalId,
          localDate: window.localDate,
          windowStart: window.start,
          windowEnd: window.end,
          status: outcome.status,
          detail: outcome.detail ?? null,
          readings: outcome.readings ?? 0,
          predictions: outcome.predictions ?? 0,
          jobsRaised: outcome.raised ?? 0,
          alertsFired: outcome.alerts ?? 0,
          durationMs,
        }));
      });
    } catch (error) {
      this.logger.error(
        `Could not record the run for ${window.externalId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Measure what the machine did with the window, on every path out of it (task P4-05).
   *
   * Three callers — scored, never-ran and nothing-to-score — and that is the point.
   * Utilization is the one product of a shift that is worth having even when there is
   * nothing to score: the shifts that produce no prediction are the idle ones, the
   * offline ones and the ones nobody was watching, and a report assembled only from
   * the shifts that scored would be a report about the machines that were working.
   *
   * Never fatal, for the same reason the alert pass is not. The prediction is the
   * product; losing it because a duty-cycle row could not be written would be the
   * wrong way round, and the window can be measured again when late telemetry rewinds
   * it — the row is upserted rather than appended.
   */
  private async recordUtilization(
    window: OwedWindow,
    readings: { signal: string; value: number; unit: string | null; sourceTimestamp: string }[],
  ): Promise<void> {
    try {
      await this.utilization.record({
        tenantId: window.tenantId,
        shiftId: window.shiftId,
        shiftName: window.shiftName,
        sourceSystem: window.sourceSystem,
        externalId: window.externalId,
        localDate: window.localDate,
        duty: computeDutyCycle(readings, window.start, window.end),
      });
    } catch (error) {
      this.logger.error(
        `Could not record utilization for ${window.externalId} on ${window.localDate}: `
        + `${(error as Error).message}`,
      );
    }
  }

  /**
   * Ask why the window was thin, per logger, on every path out of it (task P4-08).
   *
   * The device list comes from the sensor map rather than from the readings, and that
   * is the point: a logger that reported nothing contributes no readings, so building
   * the list from them would omit exactly the devices worth finding. A machine whose
   * whole window was silent produces a `dark` row per fitted logger rather than no rows
   * at all.
   *
   * Never fatal, like the alert and duty-cycle passes. A diagnosis that could not be
   * written is worth less than the prediction it would have explained.
   */
  private async recordLinkHealth(
    window: OwedWindow,
    readings: { imei?: string; signal: string; value: number; unit: string | null; sourceTimestamp: string }[],
  ): Promise<void> {
    try {
      const expected = await this.reader.expectedSignalsFor(window);
      if (expected.size === 0) return;

      const arrivals = new Map(
        (await this.reader.arrivalStats({
          tenantId: window.tenantId,
          sourceSystem: window.sourceSystem,
          externalId: window.externalId,
          from: window.start,
          to: window.end,
        })).map((a) => [a.imei, a]),
      );

      for (const [imei, expectedSignals] of expected) {
        const mine = readings.filter((r) => r.imei === imei);
        const health = assessLink({
          windowStart: window.start,
          windowEnd: window.end,
          readings: mine,
          expectedSignals,
          arrival: arrivals.get(imei) ?? null,
        });
        await this.deviceHealth.record({
          tenantId: window.tenantId,
          imei,
          sourceSystem: window.sourceSystem,
          externalId: window.externalId,
          localDate: window.localDate,
          health,
        });
      }
    } catch (error) {
      this.logger.error(
        `Could not assess link health for ${window.externalId} on ${window.localDate}: `
        + `${(error as Error).message}`,
      );
    }
  }

  /**
   * What the machine's physical chains say about this window (task P4-01).
   *
   * Run on the readings the pull already produced rather than re-read from the
   * database: the runner has them, and a second read would be the same rows fetched
   * again a moment later.
   *
   * Never fatal, and an empty result is the honest answer for the ordinary cases — a
   * machine with no equipment class, or a class nobody has written a chain for yet.
   * A chain rule then does not fire, which is correct: it is a rule about where a
   * fault entered, and nobody looked.
   */
  private async diagnoseChains(
    window: OwedWindow,
    readings: { signal: string; value: number; sourceTimestamp: string }[],
  ): Promise<WindowChain[]> {
    try {
      const samples = readings.map((r) => ({
        signal: r.signal, value: r.value, at: new Date(r.sourceTimestamp).getTime(),
      })).filter((s) => Number.isFinite(s.at));

      const diagnoses = await this.chains.diagnoseFromSamples(
        window.tenantId,
        { sourceSystem: window.sourceSystem, externalId: window.externalId },
        samples,
      );
      return diagnoses.map((d) => ({
        slug: d.slug,
        evaluated: d.evaluated,
        origin: d.origin && {
          signal: d.origin.signal,
          label: d.origin.label,
          severity: d.origin.severity,
          residual: d.origin.residual,
          expected: d.origin.expected,
          actual: d.origin.actual,
          exceedance: d.origin.exceedance,
        },
        explainedBy: d.explainedBy,
      }));
    } catch (error) {
      this.logger.error(
        `Could not run chains for ${window.externalId} on ${window.localDate}: `
        + `${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Ask the client's own rules whether this shift is worth telling anybody about.
   *
   * Never fatal. An alert is a message about work that has already been done
   * correctly, and losing the scoring because a rule could not be evaluated would be
   * the wrong trade — the prediction is the product.
   */
  private async evaluateAlerts(
    window: OwedWindow,
    readings: { signal: string; value: number; unit: string | null; sourceTimestamp: string }[],
    predictions: {
      clientScenarioSlug: string; severity: any; riskScore: number;
      predictionId: string; confidence: string;
    }[],
    chains: WindowChain[] = [],
  ): Promise<number> {
    try {
      const fired = await this.alerts.evaluateWindow({
        tenantId: window.tenantId,
        sourceSystem: window.sourceSystem,
        externalId: window.externalId,
        shiftLocalDate: window.localDate,
        windowStart: window.start,
        windowEnd: window.end,
        readings,
        predictions,
        chains,
      });
      return fired.length;
    } catch (error) {
      this.logger.error(
        `Scored ${window.externalId} but could not evaluate alerts: ${(error as Error).message}`,
      );
      return 0;
    }
  }

  /**
   * The identity a scheduled pass acts under.
   *
   * Not a person, and not unrestricted. It is scoped to the one account whose shift is
   * being scored and carries `prediction.run` and nothing else, so a bug here cannot
   * reach anything but the thing it exists to do.
   */
  private runnerScope(tenantId: string): RequestScope {
    return {
      tenantId,
      userId: 'system:shift-runner',
      roles: ['system'],
      isPlatformRole: false,
      capabilities: ['prediction.run', 'prediction.read'],
    };
  }

  private outcome(window: OwedWindow, status: RunOutcome['status'], detail?: string): RunOutcome {
    return {
      shiftId: window.shiftId, tenantId: window.tenantId, externalId: window.externalId,
      localDate: window.localDate, status, detail,
    };
  }
}
