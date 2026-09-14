import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ServiceTier } from './equipment-profile.entity';
import { EquipmentService } from './services/equipment.service';
import { PlantService } from './services/plant.service';

export class PlantDto {
  @IsString() @IsNotEmpty() code: string;
  @IsString() @IsNotEmpty() name: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() siteArea?: string;
  @IsOptional() @IsString() capacity?: string;
  @IsOptional() @IsString() projectType?: string;
  @IsOptional() @IsString() operationalStatus?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() sourceSystem?: string;
  @IsOptional() @IsString() externalId?: string;
}

export class PlantPatchDto {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() siteArea?: string;
  @IsOptional() @IsString() capacity?: string;
  @IsOptional() @IsString() projectType?: string;
  @IsOptional() @IsString() operationalStatus?: string;
  @IsOptional() @IsString() description?: string;
}

export class EquipmentDto {
  @IsString() @IsNotEmpty() code: string;
  @IsString() @IsNotEmpty() name: string;
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() modelNumber?: string;
  @IsOptional() @IsString() serialNumber?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() plantId?: string;
  @IsOptional() @IsString() equipmentClassSlug?: string;
  @IsOptional() @IsIn(['basic', 'standard', 'advanced', 'full']) tier?: ServiceTier;
  @IsOptional() @IsISO8601() commissionedAt?: string;
  @IsOptional() @IsInt() serviceIntervalHours?: number;
}

export class EquipmentPatchDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() modelNumber?: string;
  @IsOptional() @IsString() serialNumber?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() equipmentClassSlug?: string;
  @IsOptional() @IsIn(['basic', 'standard', 'advanced', 'full']) tier?: ServiceTier;
  @IsOptional() @IsISO8601() commissionedAt?: string;
  @IsOptional() @IsInt() serviceIntervalHours?: number;
}

export class MoveDto {
  /** Null takes the machine off site without retiring it. */
  @IsOptional() @IsString() toPlantId?: string | null;
  @IsString() @IsNotEmpty() reason: string;
}

export class ReasonDto {
  @IsString() @IsNotEmpty() reason: string;
}

/**
 * The client's sites and machines (tasks P1-85, P1-86).
 *
 * Owned by their CEO or manager. Every route runs inside the caller's own account,
 * so nothing here needs to check which customer is asking.
 */
@ApiTags('Equipment')
@Controller('equipment')
export class EquipmentController {
  constructor(
    private readonly equipment: EquipmentService,
    private readonly plants: PlantService,
  ) {}

  @Get('plants')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Sites in this account' })
  listPlants(@CurrentScope() scope: RequestScope, @Query('includeRetired') includeRetired?: string) {
    return this.plants.list(scope, includeRetired === 'true');
  }

  @Post('plants')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Add a site' })
  createPlant(@CurrentScope() scope: RequestScope, @Body() body: PlantDto) {
    return this.plants.create(scope, body);
  }

  @Patch('plants/:id')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Rename or re-describe a site. Its id never moves' })
  updatePlant(
    @CurrentScope() scope: RequestScope,
    @Param('id') id: string,
    @Body() body: PlantPatchDto,
  ) {
    return this.plants.update(scope, id, body);
  }

  @Post('plants/:id/retire')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Close a site, once nothing is standing on it' })
  retirePlant(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.plants.retire(scope, id);
  }

  @Post('plants/:id/reopen')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Reopen a closed site' })
  reopenPlant(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.plants.reopen(scope, id);
  }

  @Get()
  @Requires('catalog.read')
  @ApiOperation({ summary: 'The equipment register for this account' })
  list(
    @CurrentScope() scope: RequestScope,
    @Query('plantId') plantId?: string,
    @Query('includeRetired') includeRetired?: string,
  ) {
    return this.equipment.list(scope, { plantId, includeRetired: includeRetired === 'true' });
  }

  @Post()
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Add a machine. Its code becomes half of its identity' })
  create(@CurrentScope() scope: RequestScope, @Body() body: EquipmentDto) {
    return this.equipment.create(scope, {
      ...body,
      commissionedAt: body.commissionedAt ? new Date(body.commissionedAt) : null,
    });
  }

  @Patch(':sourceSystem/:externalId')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Edit a machine. Placement has its own route' })
  update(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Body() body: EquipmentPatchDto,
  ) {
    return this.equipment.update(scope, { sourceSystem, externalId }, {
      ...body,
      commissionedAt: body.commissionedAt ? new Date(body.commissionedAt) : undefined,
    });
  }

  @Post(':sourceSystem/:externalId/move')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Move a machine to another site. Requires a reason' })
  move(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Body() body: MoveDto,
  ) {
    return this.equipment.move(scope, { sourceSystem, externalId }, body.toPlantId ?? null, body.reason);
  }

  @Get(':sourceSystem/:externalId/placements')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Where this machine has been, and who moved it' })
  placements(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.equipment.placementHistory(scope, { sourceSystem, externalId });
  }

  @Post(':sourceSystem/:externalId/retire')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Retire a machine. It leaves its site' })
  retire(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Body() body: ReasonDto,
  ) {
    return this.equipment.retire(scope, { sourceSystem, externalId }, body.reason);
  }

  @Post('import/:sourceSystem')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Adopt the machines the existing platform already knows about' })
  importFromMirror(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
  ) {
    return this.equipment.importFromMirror(scope, sourceSystem);
  }
}
