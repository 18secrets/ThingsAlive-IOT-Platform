import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { CausalChainDefinition } from './entities/causal-chain.entity';
import { IntelligenceController } from './intelligence.controller';
import { ChainService } from './services/chain.service';

/**
 * The physical ML layer (task P4-01).
 *
 * First slice: the chains themselves, and running them against a machine on demand.
 * Wiring a diagnosis into the shift runner so it lands beside the prediction, and
 * letting an alert rule fire on the chain's origin rather than on a raw threshold, are
 * the next two — and both want this to be reviewed first, because the shape of a chain
 * is the part that is expensive to change later.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CausalChainDefinition, EquipmentProfile])],
  controllers: [IntelligenceController],
  providers: [ChainService],
  exports: [ChainService],
})
export class IntelligenceModule {}
