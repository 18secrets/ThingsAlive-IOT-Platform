import { Injectable, Logger } from '@nestjs/common';
import { RequestScope } from '../../auth/types/request-scope';
import { LegacyTelemetryReader } from '../../legacy/legacy-telemetry.reader';
import { PredictionService } from '../../prediction/services/prediction.service';
import { TelemetryService } from '../../telemetry/telemetry.service';
import { OwedWindow, ShiftService } from './shift.service';

export interface RunOutcome {
  shiftId: string;
  tenantId: string;
  externalId: string;
  localDate: string;
  status: 'scored' | 'nothing-to-score' | 'failed';
  readings?: number;
  predictions?: number;
  raised?: number;
  detail?: string;
}

export interface RunSummary {
  considered: number;
  scored: number;
  skipped: number;
  failed: number;
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
    private readonly shifts: ShiftService,
    private readonly reader: LegacyTelemetryReader,
    private readonly telemetry: TelemetryService,
    private readonly predictions: PredictionService,
  ) {}

  async run(now = new Date()): Promise<RunSummary> {
    const owed = await this.shifts.owed(now);
    const summary: RunSummary = { considered: owed.length, scored: 0, skipped: 0, failed: 0, outcomes: [] };
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
      const outcome = await this.one(window);
      summary.outcomes.push(outcome);
      if (outcome.status === 'scored') summary.scored += 1;
      else if (outcome.status === 'failed') summary.failed += 1;
      else summary.skipped += 1;
    }
    return summary;
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
        // A shift that produced no readings is a fact about the shift, not a failure
        // to be retried forever: the machine was off, or unfitted, and coming back to
        // the same empty window on every pass would stall everything behind it. The
        // watermark moves, and the absence is what the next screen should show.
        await this.shifts.markScored(window.tenantId, window.shiftId, window.end);
        return this.outcome(window, 'nothing-to-score', pull.reason);
      }

      const ingested = await this.telemetry.ingest(pull.envelope);
      const scope = this.runnerScope(window.tenantId);
      const result = await this.predictions.scoreAsset(
        scope, { sourceSystem: window.sourceSystem, externalId: window.externalId }, window.end,
      );

      // Last, and only now. Everything above either happened or threw.
      await this.shifts.markScored(window.tenantId, window.shiftId, window.end);

      return {
        ...this.outcome(window, 'scored'),
        readings: ingested.accepted,
        predictions: result.written.length,
        raised: result.raised.length,
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
