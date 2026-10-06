import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantParameter } from './entities/tenant-parameter.entity';
import { ParameterController } from './parameter.controller';
import { ParameterService } from './services/parameter.service';

/**
 * Client parameters and cost profiles (task QPARAM1).
 *
 * The evaluator and `coverage()` read values through `parameter-resolution.ts`'s plain
 * functions, inside their own tenant session, rather than through this module's
 * service — so neither has to import this module, and the read happens in the same
 * transaction as the telemetry it is paired with.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TenantParameter])],
  controllers: [ParameterController],
  providers: [ParameterService],
  exports: [ParameterService],
})
export class ParameterModule {}
