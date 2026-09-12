import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Prediction } from './entities/prediction.entity';
import { PredictionBaseline } from './entities/prediction-baseline.entity';
import { PredictionController } from './prediction.controller';
import { BaselineService } from './services/baseline.service';
import { PredictionService } from './services/prediction.service';

@Module({
  imports: [TypeOrmModule.forFeature([Prediction, PredictionBaseline])],
  controllers: [PredictionController],
  providers: [PredictionService, BaselineService],
  exports: [PredictionService, BaselineService],
})
export class PredictionModule {}
