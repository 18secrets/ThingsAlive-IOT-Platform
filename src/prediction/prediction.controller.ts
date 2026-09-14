import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { BaselineService, DEFAULT_WINDOW_DAYS } from './services/baseline.service';
import { PredictionService } from './services/prediction.service';

/**
 * Reading predictions, and re-running the scorer by hand (tasks P1-12, P1-14).
 *
 * Scoring is normally a consequence of telemetry arriving rather than of somebody
 * asking. These routes exist for the two cases where asking is the point: an operator
 * who has just fitted a sensor and wants to know now, and support reproducing a
 * customer's number while looking at it.
 */
@ApiTags('Predictions')
@Controller('predictions')
export class PredictionController {
  constructor(
    private readonly predictions: PredictionService,
    private readonly baselines: BaselineService,
  ) {}

  @Get(':sourceSystem/:externalId')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'The latest prediction per active scenario on one asset' })
  latest(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.predictions.latestFor(scope, { sourceSystem, externalId });
  }

  @Get(':sourceSystem/:externalId/:clientScenarioSlug/history')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'How one scenario has scored over time on this asset' })
  history(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Param('clientScenarioSlug') clientScenarioSlug: string,
    @Query('take') take?: string,
  ) {
    return this.predictions.historyFor(
      scope, { sourceSystem, externalId, clientScenarioSlug }, take ? Number(take) : 100,
    );
  }

  @Get(':sourceSystem/:externalId/baselines')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'What normal currently looks like on this asset' })
  assetBaselines(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('windowDays') windowDays?: string,
  ) {
    return this.baselines.forAsset(
      scope, { sourceSystem, externalId }, windowDays ? Number(windowDays) : DEFAULT_WINDOW_DAYS,
    );
  }

  @Post(':sourceSystem/:externalId/baselines/refresh')
  @Requires('prediction.run')
  @ApiOperation({ summary: 'Recompute this asset\'s baselines from telemetry' })
  refresh(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('windowDays') windowDays?: string,
  ) {
    return this.baselines.refresh(
      scope, { sourceSystem, externalId }, windowDays ? Number(windowDays) : DEFAULT_WINDOW_DAYS,
    );
  }

  @Post(':sourceSystem/:externalId/score')
  @Requires('prediction.run')
  @ApiOperation({ summary: 'Score every active scenario on this asset now' })
  score(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.predictions.scoreAsset(scope, { sourceSystem, externalId });
  }
}
