import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { Weekday } from './services/shift-window';
import { ShiftService } from './services/shift.service';

export class ShiftDto {
  @IsString() @IsNotEmpty() name: string;
  @IsInt() @Min(0) @Max(1439) startMinute: number;
  @IsInt() @Min(1) @Max(1440) endMinute: number;
  @IsArray() @ArrayMaxSize(7) days: Weekday[];
  @IsString() @IsNotEmpty() timeZone: string;
}

export class ShiftPatchDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1439) startMinute?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1440) endMinute?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(7) days?: Weekday[];
  @IsOptional() @IsString() timeZone?: string;
}

/**
 * When a machine is worked (task P1-109).
 *
 * Behind `equipment.write`, because a shift is part of the equipment master the
 * client's CEO or manager owns — and because changing it changes when the machine is
 * scored, which is not an operator's decision to make.
 */
@ApiTags('Shifts')
@Controller('equipment/:sourceSystem/:externalId/shifts')
export class ShiftController {
  constructor(private readonly shifts: ShiftService) {}

  @Get()
  @Requires('catalog.read')
  @ApiOperation({ summary: 'The working day for this machine' })
  list(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.shifts.list(scope, { sourceSystem, externalId });
  }

  @Post()
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Add a shift. Hours are wall-clock in the plant\'s own zone' })
  create(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Body() body: ShiftDto,
  ) {
    return this.shifts.create(scope, { sourceSystem, externalId }, body);
  }

  @Patch(':id')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Change the hours, the days or the zone' })
  update(
    @CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: ShiftPatchDto,
  ) {
    return this.shifts.update(scope, id, body);
  }

  @Post(':id/retire')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Stop scoring this shift, without losing what it explained' })
  retire(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.shifts.retire(scope, id);
  }

  @Post(':id/reinstate')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Start it again, from now rather than from where it stopped' })
  reinstate(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.shifts.reinstate(scope, id);
  }
}
