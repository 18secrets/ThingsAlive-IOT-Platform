import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { AlertAppliesTo } from '../alert/entities/alert-rule.entity';
import { WorkflowService } from './workflow.service';
import { WorkflowSpec } from './workflow-spec';

export class WorkflowCreateDto {
  @IsString() @IsNotEmpty() slug: string;
  @IsString() @IsNotEmpty() name: string;
  @IsOptional() @IsString() description?: string;
  // Shape-checked by the compiler, which names what is wrong rather than a path in a DTO.
  @IsObject() spec: WorkflowSpec;
}

export class WorkflowSpecDto {
  @IsObject() spec: WorkflowSpec;
}

export class WorkflowLayoutDto {
  @IsObject() positions: Record<string, unknown>;
}

export class AssembleTargetDto {
  @IsIn(['account', 'plant', 'equipment', 'equipment-class']) appliesTo: AlertAppliesTo;
  @IsOptional() @IsString() plantId?: string;
  @IsOptional() @IsString() sourceSystem?: string;
  @IsOptional() @IsString() externalId?: string;
  @IsOptional() @IsString() equipmentClassSlug?: string;
}

export class AssembleDto {
  @ValidateNested() @Type(() => AssembleTargetDto) target: AssembleTargetDto;
  @IsOptional() @IsString() failureModeCode?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) alertTemplateSlugs?: string[];
  @IsOptional() @IsIn(['allOf', 'anyOf']) combine?: 'allOf' | 'anyOf';
}

/**
 * Workflows (task QWF1).
 *
 * `alert.author` for every write and for assembly: a published alert workflow *is*
 * alert rules, and that capability already gates writing them (D43 Q6). Reads reuse
 * `prediction.read`, for the reason the alert controller gives. No new capability:
 * operator drafting and delegated publish are a later task, decided once.
 */
@ApiTags('Workflows')
@Controller('workflows')
export class WorkflowController {
  constructor(private readonly workflows: WorkflowService) {}

  @Post('assemble')
  @HttpCode(200)
  @Requires('alert.author')
  @ApiOperation({ summary: 'Selections + this account\'s library → a WorkflowSpec, its reading and what is unresolved. Writes nothing' })
  assemble(@CurrentScope() scope: RequestScope, @Body() body: AssembleDto) {
    return this.workflows.assemble(scope, body);
  }

  @Get()
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Workflows, each version with its status, its reading and which of its rules are off' })
  list(@CurrentScope() scope: RequestScope) {
    return this.workflows.list(scope);
  }

  @Get(':id')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'One workflow, as list' })
  get(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.workflows.get(scope, id);
  }

  @Post()
  @Requires('alert.author')
  @ApiOperation({ summary: 'A workflow and its draft version 1' })
  create(@CurrentScope() scope: RequestScope, @Body() body: WorkflowCreateDto) {
    return this.workflows.create(scope, body);
  }

  @Put(':id/versions/:v/spec')
  @Requires('alert.author')
  @ApiOperation({ summary: 'Replace a draft\'s spec. 409 on anything but a draft' })
  replaceSpec(
    @CurrentScope() scope: RequestScope, @Param('id') id: string, @Param('v', ParseIntPipe) v: number,
    @Body() body: WorkflowSpecDto,
  ) {
    return this.workflows.replaceSpec(scope, id, v, body.spec);
  }

  @Put(':id/versions/:v/layout')
  @Requires('alert.author')
  @ApiOperation({ summary: 'Node positions only. Never changes the graph hash' })
  layout(
    @CurrentScope() scope: RequestScope, @Param('id') id: string, @Param('v', ParseIntPipe) v: number,
    @Body() body: WorkflowLayoutDto,
  ) {
    return this.workflows.setLayout(scope, id, v, body.positions);
  }

  @Post(':id/versions/:v/compile')
  @HttpCode(200)
  @Requires('alert.author')
  @ApiOperation({ summary: 'Dry run: the rules publish would write, their reading, per-machine readiness. Writes nothing' })
  compile(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Param('v', ParseIntPipe) v: number) {
    return this.workflows.compile(scope, id, v);
  }

  @Post(':id/versions/:v/publish')
  @HttpCode(200)
  @Requires('alert.author')
  @ApiOperation({ summary: 'Compile and write the rules in one transaction. Idempotent' })
  publish(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Param('v', ParseIntPipe) v: number) {
    return this.workflows.publish(scope, id, v);
  }

  @Post(':id/retire')
  @HttpCode(200)
  @Requires('alert.author')
  @ApiOperation({ summary: 'Switch every compiled rule off and retire the published version' })
  retire(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.workflows.retire(scope, id);
  }

  @Post(':id/versions')
  @Requires('alert.author')
  @ApiOperation({ summary: 'A new draft, copied from the published version' })
  newVersion(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.workflows.newVersion(scope, id);
  }
}
