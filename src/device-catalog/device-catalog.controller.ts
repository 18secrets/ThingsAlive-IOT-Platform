import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Requires } from '../auth/guards/capability.guard';
import { DeviceCatalogService } from './services/device-catalog.service';

export class CreateSensorCategoryDto {
  @IsString() @IsNotEmpty()
  name: string;
}

export class SensorParameterSpecDto {
  @IsString() @IsNotEmpty() parameter: string;
  @IsString() unit: string;
  @IsNumber() min: number;
  @IsNumber() max: number;
  @IsString() normalRange: string;
  @IsOptional() @IsString() notes?: string;
}

export class SensorDto {
  @IsOptional() @IsString() sensorName?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() protocol?: string;
  // A bare `parameterSpecs: any[]` here would be silently reduced to an array of
  // `[]` by the ValidationPipe's implicit conversion — the exact bug already fixed
  // once in TemplateClassDto. @ValidateNested + @Type is what stops it happening again.
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SensorParameterSpecDto)
  parameterSpecs?: SensorParameterSpecDto[];
}

export class CreateSensorDto extends SensorDto {
  @IsString() @IsNotEmpty() declare sensorName: string;
}

export class MappedSensorDto {
  @IsString() @IsNotEmpty() sensorId: string;
  @IsArray() @IsString({ each: true }) parameters: string[];
}

export class ToolMappingDto {
  @IsOptional() @IsString() toolName?: string;
  @IsOptional() @IsString() industryType?: string;
  @IsOptional() @IsString() protocol?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => MappedSensorDto)
  mappedSensors?: MappedSensorDto[];
}

export class CreateToolMappingDto extends ToolMappingDto {
  @IsString() @IsNotEmpty() declare toolName: string;
}

/**
 * Master Admin's reference data for wiring a device before it exists: what a sensor
 * is, and which sensors + channels a tool profile expects. Every route here is
 * `device-catalog.write` — the same audience that registers the devices these
 * profiles get attached to.
 */
@ApiTags('Device catalog')
@Controller('device-catalog')
export class DeviceCatalogController {
  constructor(private readonly catalog: DeviceCatalogService) {}

  @Get('categories')
  @Requires('device-catalog.read')
  @ApiOperation({ summary: 'Sensor categories' })
  listCategories() {
    return this.catalog.listCategories();
  }

  @Post('categories')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Add a sensor category' })
  createCategory(@Body() dto: CreateSensorCategoryDto) {
    return this.catalog.createCategory(dto.name);
  }

  @Get('sensors')
  @Requires('device-catalog.read')
  @ApiOperation({ summary: 'Every reference sensor' })
  listSensors() {
    return this.catalog.listSensors();
  }

  @Post('sensors')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Add a reference sensor' })
  createSensor(@Body() dto: CreateSensorDto) {
    return this.catalog.createSensor(dto);
  }

  @Patch('sensors/:id')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Edit a reference sensor' })
  updateSensor(@Param('id') id: string, @Body() dto: SensorDto) {
    return this.catalog.updateSensor(id, dto);
  }

  @Get('tool-mappings')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Every tool mapping, with its sensors resolved by name' })
  listToolMappings() {
    return this.catalog.listToolMappings();
  }

  @Get('tool-mappings/:id')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'One tool mapping' })
  oneToolMapping(@Param('id') id: string) {
    return this.catalog.getToolMapping(id);
  }

  @Post('tool-mappings')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Assemble a tool profile from reference sensors' })
  createToolMapping(@Body() dto: CreateToolMappingDto) {
    return this.catalog.createToolMapping(dto);
  }

  @Patch('tool-mappings/:id')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Edit a tool mapping' })
  updateToolMapping(@Param('id') id: string, @Body() dto: ToolMappingDto) {
    return this.catalog.updateToolMapping(id, dto);
  }
}
