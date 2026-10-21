import { randomUUID } from 'crypto';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ProposalService } from './proposal.service';

/**
 * KPI proposal endpoints (task QGEN2, D25-D33).
 *
 * Proposing is `prediction.read` (question 5); approval remains with `proposal.approve`.
 * Intends are closed; expressions are compiled by QCE1; targets only from library or user input.
 */
@ApiTags('Proposals')
@Controller()
export class KpiProposalController {
  constructor(private readonly proposals: ProposalService) {}

  @Post('equipment/:sourceSystem/:externalId/kpi-proposals')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Propose a KPI formula for this equipment from closed intents' })
  proposeKpi(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const seed = {
      target: { sourceSystem, externalId },
      ...body,
    };
    const idempotencyKey = (body?.idempotencyKey as string) ?? (body?.idempotency_key as string) ?? randomUUID();
    return this.proposals.propose(scope, { kind: 'kpi', seed, idempotencyKey });
  }

  @Get('kpi-proposal-intents')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Closed list of KPI proposal intents and their required selections' })
  intents() {
    return [
      {
        intent: 'bind-named-formula',
        name: 'Bind Catalogue Formula',
        description: 'Bind a published formula from the catalogue to this equipment class',
        requiredFields: ['namedFormulaSlug'],
        optionalFields: ['formulaKey', 'bindings', 'targetValue', 'targetDirection', 'aggregationWindow', 'displayFormat'],
      },
      {
        intent: 'ratio-kpis',
        name: 'Ratio of Two KPIs',
        description: 'Derive a ratio from two existing formulas on this equipment class',
        requiredFields: ['formulaKeys'],
        optionalFields: ['formulaKey', 'targetValue', 'targetDirection', 'aggregationWindow', 'displayFormat'],
      },
    ];
  }
}
