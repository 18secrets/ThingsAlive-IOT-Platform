import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate, IsDefined, IsIn, IsNotEmpty, IsOptional, IsString, ValidateIf,
} from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { PARAMETER_SCOPES, ParameterScope } from './parameter-catalog';
import { ParameterService } from './services/parameter.service';

export class SetParameterDto {
  @IsIn(PARAMETER_SCOPES as unknown as string[]) scope: ParameterScope;
  @IsOptional() @IsString() scopeRef?: string;
  @IsString() @IsNotEmpty() name: string;
  /** A number, or null to clear this scope's value. Checked in the service, which
   * knows the parameter; the database checks it again. */
  @IsDefined({ message: 'value is required — send null to clear.' }) @ValidateIf((_, v) => v !== null)
  value: unknown;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @Type(() => Date) @IsDate() effectiveFrom?: Date;
}

export class SetCurrencyDto {
  @ValidateIf((_, v) => v !== null) @IsString() currency: string | null;
  @IsOptional() @Type(() => Date) @IsDate() effectiveFrom?: Date;
}

/**
 * The client's parameters and cost profiles (task QPARAM1).
 *
 * Tenant-scoped, every route. There is no platform route here and none is to be
 * added: costs and currency are the client's alone (D39). Writes need
 * `parameters.write` (super admin); reads need `parameters.read`.
 */
@ApiTags('Parameters')
@Controller('parameters')
export class ParameterController {
  constructor(private readonly parameters: ParameterService) {}

  @Get()
  @Requires('parameters.read')
  @ApiOperation({ summary: 'Effective values at a scope, each with the row that supplied it' })
  effective(
    @CurrentScope() scope: RequestScope,
    @Query('scope') target = 'client',
    @Query('scopeRef') scopeRef?: string,
    @Query('at') at?: string,
  ) {
    return this.parameters.effective(scope, { scope: parseScope(target), scopeRef }, parseDate(at) ?? new Date());
  }

  @Get('history')
  @Requires('parameters.read')
  @ApiOperation({ summary: 'Every value ever recorded for a parameter, newest first' })
  history(
    @CurrentScope() scope: RequestScope,
    @Query('name') name?: string,
    @Query('scope') target?: string,
    @Query('scopeRef') scopeRef?: string,
  ) {
    if (!name) throw new BadRequestException('name is required.');
    return this.parameters.history(scope, name, target ? { scope: parseScope(target), scopeRef } : undefined);
  }

  @Get('catalog')
  @Requires('parameters.read')
  @ApiOperation({ summary: 'The parameters a value may be set for, their units, and which formulas need them' })
  catalog(@CurrentScope() scope: RequestScope) {
    return this.parameters.catalog(scope);
  }

  @Post()
  @Requires('parameters.write')
  @ApiOperation({ summary: 'Set (or clear, with null) a value from an instant onwards. Appends; never edits.' })
  set(@CurrentScope() scope: RequestScope, @Body() body: SetParameterDto) {
    return this.parameters.set(scope, body);
  }

  @Post('currency')
  @Requires('parameters.write')
  @ApiOperation({ summary: 'Change the client currency. Refused while any cost value exists.' })
  setCurrency(@CurrentScope() scope: RequestScope, @Body() body: SetCurrencyDto) {
    return this.parameters.setCurrency(scope, body.currency, body.effectiveFrom ?? new Date());
  }
}

function parseScope(value: string): ParameterScope {
  if (!PARAMETER_SCOPES.includes(value as ParameterScope)) {
    throw new BadRequestException(`scope must be one of ${PARAMETER_SCOPES.join(', ')}.`);
  }
  return value as ParameterScope;
}

function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException('at must be an RFC 3339 timestamp.');
  return d;
}
