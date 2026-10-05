import { BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
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
  @ApiOperation({ summary: 'Sensor categories — live only unless includeRetired=true' })
  listCategories(@Query('includeRetired') includeRetired?: string) {
    return this.catalog.listCategories(parseFlag(includeRetired, 'includeRetired'));
  }

  @Post('categories')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Add a sensor category' })
  createCategory(@Body() dto: CreateSensorCategoryDto) {
    return this.catalog.createCategory(dto.name);
  }

  @Post('categories/:id/retire')
  @HttpCode(200)
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Retire a category. Refused while a live sensor is in it, naming them' })
  retireCategory(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.catalog.retireCategory(id, scope.userId);
  }

  @Post('categories/:id/unretire')
  @HttpCode(200)
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Return a retired category to use' })
  unretireCategory(@Param('id') id: string) {
    return this.catalog.unretireCategory(id);
  }

  @Get('sensors')
  @Requires('device-catalog.read')
  @ApiOperation({ summary: 'Reference sensors — live only unless includeRetired=true' })
  listSensors(@Query('includeRetired') includeRetired?: string) {
    return this.catalog.listSensors(parseFlag(includeRetired, 'includeRetired'));
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

  @Post('sensors/:id/retire')
  @HttpCode(200)
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Retire a sensor: hidden from pickers and new content, still resolving where already used' })
  retireSensor(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.catalog.retireSensor(id, scope.userId);
  }

  @Post('sensors/:id/unretire')
  @HttpCode(200)
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Return a retired sensor to the picker. Refused if its category is retired' })
  unretireSensor(@Param('id') id: string) {
    return this.catalog.unretireSensor(id);
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

/**
 * `true` or `false`, nothing else. `?includeRetired=yes` silently meaning false would
 * hide exactly the rows the caller asked to see.
 */
function parseFlag(raw: string | undefined, field: string): boolean {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new BadRequestException(`${field} must be true or false, not "${raw}".`);
}
