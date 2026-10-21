import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsISO8601, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { InventoryState } from './entities/device-inventory.entity';
import { InventoryService } from './services/inventory.service';

export class RegisterDeviceDto {
  @IsString() @IsNotEmpty()
  imei: string;

  @IsOptional() @IsString()
  model?: string;

  @IsOptional() @IsString()
  batchRef?: string;

  @IsOptional() @IsISO8601()
  receivedAt?: string;

  @IsOptional() @IsString()
  notes?: string;
}

export class RegisterBatchDto {
  @IsArray() @ArrayNotEmpty()
  // Five hundred is a delivery, not a migration. A larger import belongs in a job
  // with progress and a resume point, not in one request that times out at 80%.
  @ArrayMaxSize(500)
  devices: RegisterDeviceDto[];
}

export class AssignDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(500)
  @IsString({ each: true })
  imeis: string[];

  @IsString() @IsNotEmpty()
  tenantId: string;
}

export class MovementDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(500)
  @IsString({ each: true })
  imeis: string[];

  @IsOptional() @IsString()
  reason?: string;
}

export class ClaimDto {
  @IsString() @IsNotEmpty()
  imei: string;

  @IsString() @IsNotEmpty()
  equipmentExternalId: string;

  @IsString() @IsNotEmpty()
  sourceSystem: string;
}

/**
 * The device pool (task P1-19).
 *
 * Two audiences on one resource, split by path rather than by a role check inside a
 * shared handler. `/inventory/pool` is Things Alive's stock ledger; `/inventory/mine`
 * is a customer's own kit. A single endpoint that returned different rows depending
 * on who asked would be one refactor away from returning the wrong ones.
 */
@ApiTags('Device inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('pool')
  @Requires('device.manage')
  @ApiOperation({ summary: 'Every device Things Alive holds, assigned or not' })
  pool(
    @CurrentScope() scope: RequestScope,
    @Query('state') state?: InventoryState,
    @Query('tenantId') tenantId?: string,
    @Query('batchRef') batchRef?: string,
    @Query('unassignedOnly') unassignedOnly?: string,
  ) {
    return this.inventory.pool(scope, {
      state, tenantId, batchRef, unassignedOnly: unassignedOnly === 'true',
    });
  }

  @Post('register')
  @Requires('device.manage')
  @ApiOperation({ summary: 'Add arriving stock. Re-running a delivery note is a no-op' })
  register(@CurrentScope() scope: RequestScope, @Body() body: RegisterBatchDto) {
    return this.inventory.register(scope, body.devices.map((d) => ({
      imei: d.imei,
      model: d.model ?? null,
      batchRef: d.batchRef ?? null,
      receivedAt: d.receivedAt ? new Date(d.receivedAt) : null,
      notes: d.notes ?? null,
    })));
  }

  @Post('assign')
  @Requires('device.manage')
  @ApiOperation({ summary: 'Hand a batch of devices to one account, reporting per device' })
  assign(@CurrentScope() scope: RequestScope, @Body() body: AssignDto) {
    return this.inventory.assign(scope, body.imeis, body.tenantId);
  }

  @Post('release')
  @Requires('device.manage')
  @ApiOperation({ summary: 'Take devices back into stock. Requires a reason' })
  release(@CurrentScope() scope: RequestScope, @Body() body: MovementDto) {
    return this.inventory.release(scope, body.imeis, body.reason ?? '');
  }

  @Post('retire')
  @Requires('device.manage')
  @ApiOperation({ summary: 'Write devices off. Requires a reason' })
  retire(@CurrentScope() scope: RequestScope, @Body() body: MovementDto) {
    return this.inventory.retire(scope, body.imeis, body.reason ?? '');
  }

  @Post('return-to-stock')
  @Requires('device.manage')
  @ApiOperation({ summary: 'Bring a repaired device back out of retirement' })
  returnToStock(@CurrentScope() scope: RequestScope, @Body() body: MovementDto) {
    return this.inventory.returnToStock(scope, body.imeis);
  }

  @Get('history/:imei')
  @Requires('device.manage')
  @ApiOperation({ summary: 'Where one device has been, across every account' })
  history(@CurrentScope() scope: RequestScope, @Param('imei') imei: string) {
    return this.inventory.historyFor(scope, imei);
  }

  @Get('mine')
  @Requires('device.read')
  @ApiOperation({ summary: 'The devices in this account' })
  mine(@CurrentScope() scope: RequestScope) {
    return this.inventory.mine(scope);
  }

  @Post('claim')
  @Requires('device.claim')
  @ApiOperation({ summary: 'Fit a device in this account to one of its machines' })
  claim(@CurrentScope() scope: RequestScope, @Body() body: ClaimDto) {
    return this.inventory.claim(scope, body.imei, body.equipmentExternalId, body.sourceSystem);
  }

  @Post('unclaim')
  @Requires('device.claim')
  @ApiOperation({ summary: 'Take a device off a machine, keeping it in the account' })
  unclaim(@CurrentScope() scope: RequestScope, @Body() body: ClaimDto & { reason?: string }) {
    return this.inventory.unclaim(scope, body.imei, (body as { reason?: string }).reason ?? '');
  }
}
