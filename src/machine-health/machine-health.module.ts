import { Module } from '@nestjs/common';
import { MachineHealthController, MachineHealthService } from './machine-health.controller';

/** A machine's health score (D63). Reads only; the score is computed on request, never stored. */
@Module({
  controllers: [MachineHealthController],
  providers: [MachineHealthService],
})
export class MachineHealthModule {}
