import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EquipmentShift } from './entities/equipment-shift.entity';
import { ShiftRun } from './entities/shift-run.entity';
import { ShiftRunner } from './services/shift-runner.service';
import { ShiftScheduler } from './services/shift-scheduler.service';
import { ShiftRunService } from './services/shift-run.service';
import { ShiftService } from './services/shift.service';
import { ShiftController } from './shift.controller';
import { AlertModule } from '../alert/alert.module';
import { LegacyModule } from '../legacy/legacy.module';
import { PredictionModule } from '../prediction/prediction.module';
import { ProjectionModule } from '../projection/projection.module';
import { UtilizationModule } from '../utilization/utilization.module';
import { DeviceHealthModule } from '../device-health/device-health.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';

@Module({
  // The runner needs all three: somewhere to read from, somewhere to put it, and
  // something to score it with. The shift module is where they meet, because the
  // schedule is the thing that decides when any of it happens.
  imports: [
    TypeOrmModule.forFeature([EquipmentShift, ShiftRun]),
    LegacyModule,
    AlertModule,
    ProjectionModule,
    PredictionModule,
    // Duty cycle is measured from the same window the scorer reads, on every path
    // out of it — including the ones that produce no prediction.
    UtilizationModule,
    // The same window again, asked why it was thin rather than how thin.
    DeviceHealthModule,
    // The chains, so an alert can fire on where a fault entered rather than on a
    // raw number that a hard-working machine crosses honestly.
    IntelligenceModule,
  ],
  controllers: [ShiftController],
  providers: [ShiftService, ShiftRunner, ShiftScheduler, ShiftRunService],
  exports: [ShiftService, ShiftRunner, ShiftRunService],
})
export class ShiftModule {}
