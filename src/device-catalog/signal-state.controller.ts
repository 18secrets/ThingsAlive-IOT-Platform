import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsString, Min, ValidateNested } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { SignalStateService } from './services/signal-state.service';

export class StateEntryDto {
  @IsString() state: string;
  @IsInt() @Min(0) code: number;
}

export class ReplaceStatesDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => StateEntryDto)
  states: StateEntryDto[];
}

/**
 * What a categorical signal's codes mean (task QCAT1). Platform reference data,
 * guarded like the rest of the device catalog it sits beside.
 */
@ApiTags('Device catalog')
@Controller('device-catalog/signal-states')
export class SignalStateController {
  constructor(private readonly states: SignalStateService) {}

  @Get()
  @Requires('device-catalog.read')
  @ApiOperation({ summary: 'State vocabularies, optionally for one measurement role' })
  list(@Query('role') role?: string) {
    return this.states.list(role);
  }

  @Put(':role')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Replace one role\'s states and codes as a whole' })
  replace(@CurrentScope() scope: RequestScope, @Param('role') role: string, @Body() body: ReplaceStatesDto) {
    return this.states.replace(scope, role, body.states);
  }
}
