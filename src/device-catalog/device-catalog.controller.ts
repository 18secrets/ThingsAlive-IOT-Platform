import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, ValidateNested,
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
  /** An active industry type's id (task QINDUSTRY); `null` clears it. */
  @IsOptional() @IsUUID() industryTypeId?: string | null;
  /** Transitional: accepted only when it names one active type exactly (§7 Q6). */
  @IsOptional() @IsString() industryType?: string;
  @IsOptional() @IsString() protocol?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => MappedSensorDto)
  mappedSensors?: MappedSensorDto[];
}

export class CreateToolMappingDto extends ToolMappingDto {
  @IsString() @IsNotEmpty() declare toolName: string;
}

export class IndustryTypeDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
}

export class CreateIndustryTypeDto extends IndustryTypeDto {
  @IsString() @IsNotEmpty() declare name: string;
  @IsString() @IsNotEmpty() declare code: string;
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

  @Patch('categories/:id')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Rename a sensor category. Sensors keep it — they hold it by id' })
  renameCategory(@Param('id') id: string, @Body() dto: CreateSensorCategoryDto) {
    return this.catalog.renameCategory(id, dto.name);
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

  @Delete('sensors/:id')
  @HttpCode(204)
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Delete an unused sensor; refuses with reference counts' })
  deleteSensor(@Param('id') id: string) {
    return this.catalog.deleteSensor(id);
  }

  @Delete('categories/:id')
  @HttpCode(204)
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Delete an empty, unreferenced sensor category' })
  deleteCategory(@Param('id') id: string) {
    return this.catalog.deleteCategory(id);
  }

  // ---- Industry types (task QINDUSTRY) ---------------------------------------------

  @Get('industry-types')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Industry types; ?status=active for the tool-mapping picker' })
  listIndustryTypes(@Query('status') status?: string) {
    if (status !== undefined && status !== 'active' && status !== 'inactive') {
      throw new BadRequestException(`status must be active or inactive, not "${status}".`);
    }
    return this.catalog.listIndustryTypes(status as 'active' | 'inactive' | undefined);
  }

  @Post('industry-types')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Create an industry type' })
  createIndustryType(@CurrentScope() scope: RequestScope, @Body() dto: CreateIndustryTypeDto) {
    return this.catalog.createIndustryType(dto, scope.userId);
  }

  @Patch('industry-types/:id')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Rename, recode, activate or deactivate an industry type' })
  updateIndustryType(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() dto: IndustryTypeDto) {
    return this.catalog.updateIndustryType(id, dto, scope.userId);
  }

  @Delete('industry-types/:id')
  @HttpCode(204)
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Delete an industry type no tool mapping uses; 409 naming the count otherwise' })
  deleteIndustryType(@Param('id') id: string) {
    return this.catalog.deleteIndustryType(id);
  }

  // Before `tool-mappings/:id`, which would otherwise read the path segment as an id.
  @Get('tool-mappings/unmatched-industries')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Pre-QINDUSTRY industry text that matches no type, with counts' })
  unmatchedIndustries() {
    return this.catalog.unmatchedIndustries();
  }

  @Post('tool-mappings/unmatched-industries/rematch')
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Match unmatched mappings to the active types that now exist; never moves a set one' })
  rematchIndustries() {
    return this.catalog.rematchIndustries();
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

  @Delete('tool-mappings/:id')
  @HttpCode(204)
  @Requires('device-catalog.write')
  @ApiOperation({ summary: 'Delete a tool mapping no device uses; refused while any device does' })
  deleteToolMapping(@Param('id') id: string) {
    return this.catalog.deleteToolMapping(id);
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
