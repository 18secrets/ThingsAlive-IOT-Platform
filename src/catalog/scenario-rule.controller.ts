import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Requires } from '../auth/guards/capability.guard';
import { ScenarioRule, scenarioRule } from '../prediction/services/scenario-rule';
import { ScenarioDefinition } from './entities/scenario-definition.entity';

/**
 * A library scenario's scoring rule, in the numbers the scorer will use (fuel test report
 * FU-1, TC-FP-01). Beside the authoring list, behind the same `catalog.write`: it is for the
 * people who write and publish scenarios, so they can validate what a scenario does before
 * every account granted the class runs it.
 */
@ApiTags('Catalog')
@Controller('catalog/authoring/scenarios')
export class ScenarioRuleController {
  constructor(@InjectRepository(ScenarioDefinition) private readonly scenarios: Repository<ScenarioDefinition>) {}

  @Get(':id/rule')
  @Requires('catalog.write')
  @ApiOperation({
    summary: 'How this scenario version is scored: inputs, window and thresholds, as the scorer reads them',
    description: 'method is what scores it first: influence@1 when it carries an influence model (expected target from '
      + 'its influences; residual thresholds), tier1@1 otherwise. baseline is always present: the machine\'s own operating '
      + 'average and spread over windowDays, warning and critical in standard deviations, and the fallback when an '
      + 'influence window cannot answer.',
  })
  async rule(@Param('id', ParseUUIDPipe) id: string): Promise<ScenarioRule & { scenarioId: string; slug: string; version: number }> {
    const s = await this.scenarios.findOne({ where: { id } });
    if (!s) throw new NotFoundException('No such scenario version.');
    return { scenarioId: s.id, slug: s.slug, version: s.version, ...scenarioRule(s) };
  }
}
