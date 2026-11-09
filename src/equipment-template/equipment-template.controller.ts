import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsNotEmpty, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { EquipmentTemplateService } from './services/equipment-template.service';

export class EquipmentTemplateDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() engineType?: string;
  @IsOptional() @IsNumber() fuelTankCapacityLiters?: number;
  @IsOptional() @IsNumber() serviceIntervalHours?: number;
  @IsOptional() @IsString() description?: string;
  /** The library class this is a model of (D57). */
  @IsOptional() @IsString() equipmentClassSlug?: string;
}

/** One rated figure (D57). `unit` is optional and, when given, must be the rating's own. */
export class RatingDto {
  @IsString() @IsNotEmpty() name: string;
  @IsNumber() value: number;
  @IsOptional() @IsString() unit?: string;
  @IsString() @IsNotEmpty() source: string;
}

export class RatingsDto {
  // Without @ValidateNested a whitelisting pipe strips the list and then refuses the
  // request for carrying it (the same trap ProvisionDto.superAdmin documents).
  @IsArray() @ArrayMaxSize(64) @ValidateNested({ each: true }) @Type(() => RatingDto)
  ratings: RatingDto[];
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

  @Get(':id/ratings')
  @Requires('equipment-template.read')
  @ApiOperation({ summary: 'The model\'s rated figures, each with its unit and source (D57)' })
  ratings(@Param('id') id: string) {
    return this.templates.ratings(id);
  }

  @Put(':id/ratings')
  @Requires('equipment-template.write')
  @ApiOperation({ summary: 'Replace the model\'s rated figures. Idempotent; accounts\' copies are not changed' })
  replaceRatings(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() dto: RatingsDto) {
    return this.templates.replaceRatings(scope, id, dto.ratings);
  }
}
