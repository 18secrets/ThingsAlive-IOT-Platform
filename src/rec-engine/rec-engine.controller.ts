import { Controller, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { RecEngineService } from './rec-engine.service';

const OUTCOMES = 'A ready bundle has an outcome: attributed (a library failure mode is active), unattributed '
  + '(something is anomalous that no mode names), inconclusive (nothing active, but a signal could not be seen) or '
  + 'nothing_detected (every named signal seen and normal). A refused bundle is not_configured (unclassified, '
  + 'class_not_in_account, no_library_content) or blocked (insufficient_coverage), and still carries every '
  + 'step\'s coverage so the screen can say why.';

/**
 * The recommendation evidence bundle over HTTP (task QREC1 §8).
 *
 * `prediction.read` on all three, the gate alerts and incidents already use. The POST
 * writes only a derived, immutable record of reads the caller could make anyway, so it
 * changes nothing operational (question 3, answered: D42). A machine outside the
 * caller's scope is a 404, the same answer as any other equipment route.
 */
@ApiTags('Recommendation evidence')
@Controller()
export class RecEngineController {
  constructor(private readonly engine: RecEngineService) {}

  @Post('equipment/:sourceSystem/:externalId/rec-evidence')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Run the five deterministic steps now. Idempotent: unchanged evidence returns the existing bundle', description: OUTCOMES })
  @ApiResponse({ status: 201, description: 'A new bundle: the evidence changed since the last one' })
  @ApiResponse({ status: 200, description: 'The existing bundle: nothing it read has changed' })
  @ApiResponse({ status: 201, description: 'Either way the body also carries checkedAt (when this check ran) and evidenceUnchanged' })
  async evaluate(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Res({ passthrough: true }) res: { status: (code: number) => unknown },
  ) {
    const checkedAt = new Date();
    const { bundle, created } = await this.engine.evaluate(scope, { sourceSystem, externalId }, checkedAt);
    res.status(created ? 201 : 200);
    // The bundle is the evidence and keeps its own asOf: unchanged evidence returns the
    // bundle first written for it, so a screen showing only asOf reads "analysed 23/10"
    // after a check made today. checkedAt says when this check ran; evidenceUnchanged
    // says the answer stands, rather than leaving the screen to look stale.
    return { ...bundle, checkedAt: checkedAt.toISOString(), evidenceUnchanged: !created };
  }

  @Get('equipment/:sourceSystem/:externalId/rec-evidence')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'The latest bundle for this machine; 404 when it has never been evaluated', description: OUTCOMES })
  latest(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.engine.latest(scope, { sourceSystem, externalId });
  }

  @Get('rec-evidence/:id')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'One bundle by id', description: OUTCOMES })
  byId(@CurrentScope() scope: RequestScope, @Param('id', ParseUUIDPipe) id: string) {
    return this.engine.byId(scope, id);
  }
}
