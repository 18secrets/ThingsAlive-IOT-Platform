import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ServiceKind } from './entities/equipment-service-record.entity';
import { RuntimeUnit } from './services/runtime-unit';
import { ServiceForecastService } from './services/service-forecast.service';

export class RecordServiceDto {
  @IsOptional() @IsDateString() performedAt?: string;
  @IsOptional() @IsIn(['scheduled', 'unscheduled', 'overhaul', 'meter-replaced'])
  kind?: ServiceKind;
  @IsOptional() @IsNumber() @Min(0) meterReading?: number;
  @IsOptional() @IsIn(['hours', 'minutes', 'seconds']) meterUnit?: RuntimeUnit;
  @IsOptional() @IsUUID() workOrderId?: string;
  @IsOptional() @IsString() notes?: string;
}

/**
 * When each machine is next due, and what it has had done (task P4-07).
 *
 * Reading the forecast sits behind `utilization.read` — it is the same duty-cycle data
 * answering a different question, and a customer who may see how hard a machine works
 * may see when it is next due. Writing a service record is `action.work`: it is the
 * record of a job having been done, which is the fitter's act rather than a manager's.
 */
@ApiTags('Service')
@Controller('service')
export class ServiceController {
  constructor(private readonly service: ServiceForecastService) {}

  @Get('forecast')
  @Requires('utilization.read')
  @ApiOperation({ summary: 'Next service per machine, overdue first, with the fleet comparison' })
  forecast(@CurrentScope() scope: RequestScope) {
    return this.service.fleetForecast(scope);
  }

  @Get('meter-calibration')
  @Requires('utilization.read')
  @ApiOperation({ summary: 'What unit the hour meters count in, derived from duty cycle' })
  calibration(@CurrentScope() scope: RequestScope) {
    return this.service.calibration(scope);
  }

  @Get('equipment/:sourceSystem/:externalId')
  @Requires('utilization.read')
  @ApiOperation({ summary: 'What has been done to this machine, most recent first' })
  history(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.service.history(scope, { sourceSystem, externalId });
  }

  @Post('equipment/:sourceSystem/:externalId')
  @Requires('action.work')
  @ApiOperation({ summary: 'Record a service, with the meter as it was read' })
  record(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Body() body: RecordServiceDto,
  ) {
    return this.service.recordService(scope, { sourceSystem, externalId }, {
      performedAt: body.performedAt ? new Date(body.performedAt) : undefined,
      kind: body.kind,
      meterReading: body.meterReading ?? null,
      meterUnit: body.meterUnit ?? null,
      workOrderId: body.workOrderId ?? null,
      notes: body.notes ?? null,
    });
  }
}
