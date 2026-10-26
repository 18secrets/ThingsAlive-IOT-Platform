import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { presentEnvelope } from './kpi-presentation';
import { KpiEnvelope } from './types';
import { KpiEvaluatorService } from './services/kpi-evaluator.service';

export class KpiWindowQuery {
  @IsOptional() @IsISO8601() from?: string;

  @IsOptional() @IsISO8601() to?: string;
}

/**
 * The runtime evaluator's two endpoints (task QCE2) — tenant-scoped, under the
 * tenant's own copies (`ClientFormula`), never the platform catalogue. Reuses
 * `equipment.controller.ts`'s `/equipment/:sourceSystem/:externalId` prefix
 * rather than editing that controller — a new capability, a new route group.
 */
@ApiTags('kpi')
@Controller('equipment')
export class KpiController {
  constructor(private readonly evaluator: KpiEvaluatorService) {}

  @Get(':sourceSystem/:externalId/kpis')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Every KPI the equipment\'s class declares, each with its readiness envelope' })
  async listKpis(
    @CurrentScope() scope: RequestScope,
      @Param('sourceSystem') sourceSystem: string,
      @Param('externalId') externalId: string,
  ): Promise<KpiEnvelope[]> {
    const ref = { sourceSystem, externalId };
    const [envelopes, formats] = await Promise.all([this.evaluator.evaluateAll(scope, ref), this.evaluator.displayFormats(scope, ref)]);
    return envelopes.map((e) => presentEnvelope(e, formats.get(e.formulaKey)));
  }

  @Get(':sourceSystem/:externalId/kpis/:formulaKey')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'One KPI, over its declared window or an explicit from/to' })
  async getKpi(
    @CurrentScope() scope: RequestScope,
      @Param('sourceSystem') sourceSystem: string,
      @Param('externalId') externalId: string,
      @Param('formulaKey') formulaKey: string,
      @Query() query: KpiWindowQuery,
  ): Promise<KpiEnvelope> {
    const explicitWindow = query.from && query.to
      ? { from: new Date(query.from), to: new Date(query.to) }
      : undefined;
    const ref = { sourceSystem, externalId };
    const [envelope, formats] = await Promise.all([
      this.evaluator.evaluateOne(scope, ref, formulaKey, new Date(), explicitWindow), this.evaluator.displayFormats(scope, ref),
    ]);
    return presentEnvelope(envelope, formats.get(formulaKey));
  }
}
