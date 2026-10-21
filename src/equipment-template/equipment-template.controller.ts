import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { Requires } from '../auth/guards/capability.guard';
import { EquipmentTemplateService } from './services/equipment-template.service';

export class EquipmentTemplateDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() engineType?: string;
  @IsOptional() @IsNumber() fuelTankCapacityLiters?: number;
  @IsOptional() @IsNumber() serviceIntervalHours?: number;
  @IsOptional() @IsString() description?: string;
}

export class CreateEquipmentTemplateDto extends EquipmentTemplateDto {
  @IsString() @IsNotEmpty() declare name: string;
}

/**
 * Common onboarding fields for a named/categorised kind of equipment — separate from
 * the prediction catalog (`/catalog/equipment-classes`), which this never touches.
 */
@ApiTags('Equipment templates')
@Controller('equipment-templates')
export class EquipmentTemplateController {
  constructor(private readonly templates: EquipmentTemplateService) {}

  @Get()
  @Requires('equipment-template.read')
  @ApiOperation({ summary: 'Every equipment template' })
  list() {
    return this.templates.list();
  }

  @Post()
  @Requires('equipment-template.write')
  @ApiOperation({ summary: 'Add an equipment template' })
  create(@Body() dto: CreateEquipmentTemplateDto) {
    return this.templates.create(dto);
  }

  @Patch(':id')
  @Requires('equipment-template.write')
  @ApiOperation({ summary: 'Edit an equipment template' })
  update(@Param('id') id: string, @Body() dto: EquipmentTemplateDto) {
    return this.templates.update(id, dto);
  }
}
