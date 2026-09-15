import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ChainNode } from './services/causal-chain';
import { ChainService } from './services/chain.service';

export class ChainDraftDto {
  @IsString() @IsNotEmpty() equipmentClassSlug: string;
  @IsOptional() @IsString() scenarioSlug?: string;
  @IsString() @IsNotEmpty() name: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() outcome?: string;
  // The stage shape is validated by `validateChain`, which checks the things that
  // matter — cycles, self-drive, thresholds that can never fire — rather than only
  // that the fields are present.
  @IsArray() nodes: ChainNode[];
  @IsOptional() @IsInt() @Min(1) alignmentSeconds?: number;
  @IsOptional() @IsString() provenance?: string;
}

export class ProjectInputDto {
  @IsString() @IsNotEmpty() signal: string;
  @IsNumber() value: number;
}

export class ProjectDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ProjectInputDto)
  inputs: ProjectInputDto[];
}

/**
 * The physical intelligence layer (task P4-01).
 *
 * Authoring sits behind `catalog.write`, which is Things Alive only: a chain is a claim
 * about how a kind of machine behaves, and it is part of what Things Alive sells. A
 * customer editing one would be editing the product, the same boundary that keeps them
 * out of the scenario catalog.
 *
 * Reading a diagnosis is `prediction.read`. It is a statement about the customer's own
 * machine and every role inside the tenant may see it.
 */
@ApiTags('Intelligence')
@Controller('intelligence')
export class IntelligenceController {
  constructor(private readonly chains: ChainService) {}

  @Get('chains')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Published chains for an equipment class' })
  list(@Query('equipmentClassSlug') equipmentClassSlug: string) {
    return this.chains.publishedFor(equipmentClassSlug);
  }

  @Get('authoring/chains')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Every chain version, draft and published — Things Alive only' })
  authoringChains(@Query('equipmentClassSlug') equipmentClassSlug?: string) {
    return this.chains.allFor(equipmentClassSlug);
  }

  @Post('chains/:slug')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Write a chain down as a draft, validated before it is stored' })
  draft(
    @CurrentScope() scope: RequestScope,
    @Param('slug') slug: string,
    @Body() body: ChainDraftDto,
  ) {
    return this.chains.createDraft(scope, slug, body);
  }

  @Post('chains/:slug/publish')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Stand behind the numbers. The version becomes immutable' })
  publish(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.chains.publish(scope, slug);
  }

  @Get('diagnose/:sourceSystem/:externalId')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'What every chain for this machine\'s class says about it now' })
  diagnose(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.chains.diagnose(scope, { sourceSystem, externalId });
  }

  @Post('chains/:slug/project')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Where a chain ends up if its inputs go where you say' })
  project(
    @CurrentScope() scope: RequestScope,
    @Param('slug') slug: string,
    @Body() body: ProjectDto,
  ) {
    const inputs = Object.fromEntries(body.inputs.map((i) => [i.signal, i.value]));
    return this.chains.project(scope, slug, inputs);
  }
}
