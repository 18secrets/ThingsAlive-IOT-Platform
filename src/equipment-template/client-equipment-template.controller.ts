import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { DutyCurveDto, RatingsDto } from './equipment-template.controller';
import { ClientEquipmentTemplateService } from './services/client-equipment-template.service';

/** The same fields as Master Admin's template DTO; the database holds the same rules. */
export class ClientEquipmentTemplateDto {
  @ApiPropertyOptional({ example: 'CAT 320 (our spec)' }) @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional({ example: 'Excavator' }) @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional({ example: 'Caterpillar' }) @IsOptional() @IsString() manufacturer?: string;
  @ApiPropertyOptional({ example: 'C7.1 diesel' }) @IsOptional() @IsString() engineType?: string;
  @ApiPropertyOptional({ example: 410 }) @IsOptional() @IsNumber() @IsPositive() fuelTankCapacityLiters?: number;
  @ApiPropertyOptional({ example: 250 }) @IsOptional() @IsInt() @IsPositive() serviceIntervalHours?: number;
  @ApiPropertyOptional({ example: 'Site-standard configuration with the long stick.' }) @IsOptional() @IsString() description?: string;
  /** The class this is a model of (D57). */
  @ApiPropertyOptional({ example: 'induction-motor-1ph' }) @IsOptional() @IsString() equipmentClassSlug?: string;
}

export class CreateClientEquipmentTemplateDto extends ClientEquipmentTemplateDto {
  @IsString() @IsNotEmpty() declare name: string;
}

export class CopyFromMasterDto {
  /** Defaults to the master template's own name. */
  @ApiPropertyOptional({ example: 'CAT 320 — Pune yard' }) @IsOptional() @IsString() name?: string;
}

/**
 * A client's own equipment templates (task QCLIENT-TEMPLATE), beside Master Admin's
 * read-only library at `/equipment-templates`. Onboarding fields only.
 */
@ApiTags('My equipment templates')
@Controller('my-equipment-templates')
export class ClientEquipmentTemplateController {
  constructor(private readonly templates: ClientEquipmentTemplateService) {}

  @Get()
  @Requires('equipment-template.read')
  @ApiOperation({ summary: 'This account\'s own equipment templates' })
  list(@CurrentScope() scope: RequestScope) {
    return this.templates.list(scope);
  }

  @Post()
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Add one of this account\'s own templates' })
  create(@CurrentScope() scope: RequestScope, @Body() dto: CreateClientEquipmentTemplateDto) {
    return this.templates.create(scope, dto);
  }

  @Post('from/:masterId')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Copy a Master Admin template into this account. Provenance only — later edits to the master do not follow' })
  copy(@CurrentScope() scope: RequestScope, @Param('masterId') masterId: string, @Body() dto: CopyFromMasterDto) {
    return this.templates.copyFromMaster(scope, masterId, dto.name);
  }

  @Patch(':id')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Edit one of this account\'s templates; omitted fields are unchanged' })
  update(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() dto: ClientEquipmentTemplateDto) {
    return this.templates.update(scope, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Delete one of this account\'s templates. Refused while a machine names it as its model' })
  remove(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.templates.remove(scope, id);
  }

  @Get(':id/ratings')
  @Requires('equipment-template.read')
  @ApiOperation({ summary: 'The rated figures machines of this model read (D57)' })
  ratings(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.templates.ratings(scope, id);
  }

  @Put(':id/ratings')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Replace this account\'s rated figures for the model. Idempotent' })
  replaceRatings(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() dto: RatingsDto) {
    return this.templates.replaceRatings(scope, id, dto.ratings);
  }

  @Get(':id/duty-curve')
  @Requires('equipment-template.read')
  @ApiOperation({ summary: 'The duty curve machines of this model are read against (D58)' })
  dutyCurve(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.templates.dutyCurve(scope, id);
  }

  @Put(':id/duty-curve')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Replace this account\'s duty curve for the model. Idempotent' })
  replaceDutyCurve(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() dto: DutyCurveDto) {
    return this.templates.replaceDutyCurve(scope, id, dto);
  }
}
