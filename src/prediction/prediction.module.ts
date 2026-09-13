import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Prediction } from './entities/prediction.entity';
import { PredictionBaseline } from './entities/prediction-baseline.entity';
import { PredictionController } from './prediction.controller';
import { BaselineService } from './services/baseline.service';
import { PredictionService } from './services/prediction.service';
import { WorkModule } from '../work/work.module';

@Module({
  // WorkModule supplies WORK_RAISER, so a critical prediction can raise a job in the
  // same transaction that wrote it. The dependency runs this way and not the other:
  // work orders know about machines and predictions, predictions know nothing about
  // work beyond a port they define themselves.
  imports: [TypeOrmModule.forFeature([Prediction, PredictionBaseline]), WorkModule],
  controllers: [PredictionController],
  providers: [PredictionService, BaselineService],
  exports: [PredictionService, BaselineService],
})
export class PredictionModule {}
