import { Module, OnModuleInit } from '@nestjs/common';
import { KpiModule } from '../kpi/kpi.module';
import { EmitterRegistry } from './emitter';
import { KpiEmitter } from './kpi-emitter';
import { KpiProposalController } from './kpi-proposal.controller';
import { ProposalController } from './proposal.controller';
import { ProposalService } from './proposal.service';
import { ReplayService } from './replay.service';

/**
 * The proposal substrate and KPI emitter (tasks QGEN1 and QGEN2).
 */
@Module({
  imports: [KpiModule],
  controllers: [ProposalController, KpiProposalController],
  providers: [EmitterRegistry, ReplayService, ProposalService, KpiEmitter],
  exports: [EmitterRegistry, ReplayService, ProposalService, KpiEmitter],
})
export class ProposalModule implements OnModuleInit {
  constructor(
    private readonly registry: EmitterRegistry,
    private readonly kpiEmitter: KpiEmitter,
  ) {}

  onModuleInit() {
    this.registry.register(this.kpiEmitter);
  }
}
