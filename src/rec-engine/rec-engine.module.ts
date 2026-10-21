import { Module } from '@nestjs/common';
import { RecEngineController } from './rec-engine.controller';
import { RecEngineService } from './rec-engine.service';

/** The five deterministic recommendation steps (task QREC1). Reads producers' tables; owns one. */
@Module({
  controllers: [RecEngineController],
  providers: [RecEngineService],
  exports: [RecEngineService],
})
export class RecEngineModule {}
