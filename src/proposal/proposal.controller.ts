import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { PROPOSAL_KINDS } from './proposal-kinds';
import { ProposalService } from './proposal.service';

export class ProposalListQuery {
  @IsOptional() @IsIn([...PROPOSAL_KINDS]) kind?: string;
  @IsOptional() @IsIn(['proposed', 'compile_refused', 'compiled', 'gate_refused', 'draft_ready', 'approved', 'rejected', 'materialised', 'expired'])
  status?: string;
}

export class ProposalRejectDto {
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

/**
 * Generated drafts (task QGEN1).
 *
 * Reading is `prediction.read`, like the workflows and alerts a draft becomes. Deciding
 * is `proposal.approve` (question 3): approval materialises an artifact on the account's
 * behalf, which is the tenant super admin's act (D27). There is no POST that creates a
 * proposal — QGEN2 and QGEN3 do that from a person's selection, never from a payload.
 */
@ApiTags('Proposals')
@Controller('proposals')
export class ProposalController {
  constructor(private readonly proposals: ProposalService) {}

  @Get()
  @Requires('prediction.read')
  @ApiOperation({ summary: 'This account\'s generated drafts, filterable by kind and status' })
  list(@CurrentScope() scope: RequestScope, @Query() query: ProposalListQuery) {
    return this.proposals.list(scope, query);
  }

  @Get(':id')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'One draft: payload, plain-English reading, compile result, gate outcome with its replay runs, provenance, readiness' })
  get(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.proposals.get(scope, id);
  }

  @Get(':id/replay-runs/:runId')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'One machine\'s replay: every window that fired, with its evidence' })
  replayRun(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Param('runId') runId: string) {
    return this.proposals.replayRun(scope, id, runId);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Requires('proposal.approve')
  @ApiOperation({ summary: 'Recheck scope, expiry and versions, then materialise through the kind\'s own service. Idempotent; 409 names a failed recheck' })
  approve(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.proposals.approve(scope, id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Requires('proposal.approve')
  @ApiOperation({ summary: 'Record who rejected it and why. Idempotent' })
  reject(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: ProposalRejectDto) {
    return this.proposals.reject(scope, id, body?.reason ?? null);
  }

  @Post(':id/rules/:ruleId/enable')
  @HttpCode(200)
  @Requires('alert.author')
  @ApiOperation({ summary: 'Switch on a rule materialised from an unvalidated draft, recording who chose to and the history it had. Idempotent' })
  enableRule(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Param('ruleId') ruleId: string) {
    return this.proposals.enableRule(scope, id, ruleId);
  }
}
