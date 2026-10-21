import { Module, OnModuleInit } from '@nestjs/common';
import { KpiModule } from '../kpi/kpi.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { EmitterRegistry } from './emitter';
import { KpiEmitter } from './kpi-emitter';
import { KpiProposalController } from './kpi-proposal.controller';
import { ProposalController } from './proposal.controller';
import { ProposalService } from './proposal.service';
import { ReplayService } from './replay.service';
import { WorkflowEmitter } from './workflow-emitter';
import { WorkflowProposalController } from './workflow-proposal.controller';

/**
 * The proposal substrate, KPI emitter, and workflow emitter (tasks QGEN1, QGEN2, and QGEN3).
 */
@Module({
  imports: [KpiModule, WorkflowModule],
  controllers: [ProposalController, KpiProposalController, WorkflowProposalController],
  providers: [EmitterRegistry, ReplayService, ProposalService, KpiEmitter, WorkflowEmitter],
  exports: [EmitterRegistry, ReplayService, ProposalService, KpiEmitter, WorkflowEmitter],
})
export class ProposalModule implements OnModuleInit {
  constructor(
    private readonly registry: EmitterRegistry,
    private readonly kpiEmitter: KpiEmitter,
    private readonly workflowEmitter: WorkflowEmitter,
  ) {}

  onModuleInit() {
    this.registry.register(this.kpiEmitter);
    this.registry.register(this.workflowEmitter);
  }
}
