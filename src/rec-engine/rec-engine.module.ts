import { Module } from '@nestjs/common';
import { ForecastModule } from '../forecast/forecast.module';
import { RecEngineController } from './rec-engine.controller';
import { RecEngineService } from './rec-engine.service';

/** The five deterministic recommendation steps (task QREC1). Reads producers' tables; owns one. */
@Module({
  controllers: [RecEngineController],
  imports: [ForecastModule],
  providers: [RecEngineService],
  exports: [RecEngineService],
})
export class RecEngineModule {}
