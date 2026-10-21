import { randomUUID } from 'crypto';
import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ProposalService } from './proposal.service';

/**
 * Workflow proposal endpoints (task QGEN3, D25-D28, D34).
 *
 * Proposing needs `alert.author` (§9 question 3); approval needs both `proposal.approve` and `alert.author`.
 * Closed intents; deterministic assembly from published alert template copies; mandatory 90-day historical replay.
 */
@ApiTags('Proposals')
@Controller()
export class WorkflowProposalController {
  constructor(private readonly proposals: ProposalService) {}

  @Post('workflow-proposals')
  @Requires('alert.author')
  @ApiOperation({ summary: 'Propose an alert workflow from closed intents, gated by historical replay' })
  proposeWorkflow(@CurrentScope() scope: RequestScope, @Body() body: Record<string, unknown>) {
    const idempotencyKey = (body?.idempotencyKey as string) ?? (body?.idempotency_key as string) ?? randomUUID();
    return this.proposals.propose(scope, { kind: 'workflow', seed: body, idempotencyKey });
  }

  @Get('workflow-proposal-intents')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Closed list of workflow proposal intents and their required selections' })
  intents() {
    return [
      {
        intent: 'watch-failure-mode',
        name: 'Watch Failure Mode',
        description: 'Assemble an alert workflow watching signals of a specified failure mode',
        requiredFields: ['target', 'failureModeCode'],
        optionalFields: ['combine', 'name', 'slug'],
      },
      {
        intent: 'combine-templates',
        name: 'Combine Alert Templates',
        description: 'Combine published alert templates into a workflow with allOf or anyOf',
        requiredFields: ['target', 'alertTemplateSlugs'],
        optionalFields: ['combine', 'name', 'slug'],
      },
    ];
  }
}
