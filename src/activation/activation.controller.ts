import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ActivationState } from './entities/equipment-scenario.entity';
import { ActivationService } from './services/activation.service';
import { ActivationHistoryService } from './services/activation-history.service';

export class TransitionDto {
  @IsString() @IsNotEmpty()
  sourceSystem: string;

  @IsString() @IsNotEmpty()
  externalId: string;

  @IsString() @IsNotEmpty()
  clientScenarioSlug: string;

  @IsOptional() @IsString()
  reason?: string;

  @IsOptional() @IsObject()
  parameterOverrides?: Record<string, unknown>;
}

/**
 * Turning scenarios on and off for individual assets (task P1-09).
 *
 * One route per transition rather than a single endpoint taking a target state. The
 * transitions are not symmetrical — pause and deactivate demand a reason, activate
 * checks the asset can run the thing — and a single `PUT state` would either hide
 * that or grow a switch that re-implements the state machine in the controller.
 */
@ApiTags('Activation')
@Controller('activations')
export class ActivationController {
  constructor(
    private readonly activation: ActivationService,
    private readonly history: ActivationHistoryService,
  ) {}

  @Get()
  @Requires('client-catalog.read')
  @ApiOperation({ summary: 'Scenarios running in this account, with resolved parameters' })
  list(
    @CurrentScope() scope: RequestScope,
    @Query('sourceSystem') sourceSystem?: string,
    @Query('externalId') externalId?: string,
    @Query('state') state?: ActivationState,
  ) {
    return this.activation.list(scope, { sourceSystem, externalId, state });
  }

  @Get('history/:sourceSystem/:externalId')
  @Requires('client-catalog.read')
  @ApiOperation({ summary: 'Who turned what on and off for this asset, and why' })
  assetHistory(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.history.forAsset(scope, sourceSystem, externalId);
  }

  @Post('propose')
  @Requires('scenario.activate')
  @ApiOperation({ summary: 'Record a suggestion without running it' })
  propose(@CurrentScope() scope: RequestScope, @Body() dto: TransitionDto) {
    return this.activation.apply(scope, 'propose', dto, dto);
  }

  @Post('activate')
  @Requires('scenario.activate')
  @ApiOperation({
    summary: 'Run it. Refused when the asset is the wrong class; allowed with blockers recorded otherwise',
  })
  activate(@CurrentScope() scope: RequestScope, @Body() dto: TransitionDto) {
    return this.activation.apply(scope, 'activate', dto, dto);
  }

  @Post('pause')
  @Requires('scenario.activate')
  @ApiOperation({ summary: 'Off, with the intent of coming back. Reason required' })
  pause(@CurrentScope() scope: RequestScope, @Body() dto: TransitionDto) {
    return this.activation.apply(scope, 'pause', dto, dto);
  }

  @Post('resume')
  @Requires('scenario.activate')
  resume(@CurrentScope() scope: RequestScope, @Body() dto: TransitionDto) {
    return this.activation.apply(scope, 'resume', dto, dto);
  }

  @Post('deactivate')
  @Requires('scenario.activate')
  @ApiOperation({ summary: 'Off for good. The row stays. Reason required' })
  deactivate(@CurrentScope() scope: RequestScope, @Body() dto: TransitionDto) {
    return this.activation.apply(scope, 'deactivate', dto, dto);
  }
}
