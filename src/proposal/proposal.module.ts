import { Module } from '@nestjs/common';
import { EmitterRegistry } from './emitter';
import { ProposalController } from './proposal.controller';
import { ProposalService } from './proposal.service';
import { ReplayService } from './replay.service';

/**
 * The proposal substrate. Ships no emitter: QGEN2 (KPI) and QGEN3 (workflow) import this
 * module and register theirs with `EmitterRegistry` when their module starts.
 */
@Module({
  controllers: [ProposalController],
  providers: [EmitterRegistry, ReplayService, ProposalService],
  exports: [EmitterRegistry, ReplayService, ProposalService],
})
export class ProposalModule {}
