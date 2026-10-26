import { Module } from '@nestjs/common';
import { ForecastApiController } from './forecast-api.controller';
import { ForecastApiService } from './forecast-api.service';
import { ForecastModule } from './forecast.module';

/**
 * The forecast routes, apart from `ForecastModule` because `forecast-main` boots that
 * module on its own as the pass's child process, which has no HTTP and should not carry
 * routes it can never serve.
 */
@Module({
  imports: [ForecastModule],
  controllers: [ForecastApiController],
  providers: [ForecastApiService],
})
export class ForecastApiModule {}
