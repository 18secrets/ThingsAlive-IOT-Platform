import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Requires } from '../auth/guards/capability.guard';
import { VaniLinksService } from './vani-links.service';

export class VaniAccountLinkDto {
  @IsString() @IsNotEmpty() @MaxLength(200) vaniAccountId: string;
  // Same shapes the database holds; checked here too so the refusal names the field
  // before the request reaches a transaction.
  @IsOptional() @IsString() @Matches(/^\+[1-9][0-9]{6,14}$/, { message: 'customerPhone must be E.164: a + and the country code, digits only.' })
  customerPhone?: string;
  @IsOptional() @IsString() @Matches(/^https:\/\//, { message: 'callbackUrl must be https.' })
  callbackUrl?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class VaniMachineLinkDto {
  @IsString() @IsNotEmpty() @MaxLength(200) machineId: string;
  // Read aloud on the call, so it is what a person would say, as Vani registered it.
  @IsString() @IsNotEmpty() @MaxLength(200) spokenName: string;
}

/**
 * Linking a customer to the Vani account Vani operations registered for them, and each
 * of their machines to its Vani machine id (integration guide §3–4). Master admin only:
 * a wrong link phones one customer about another's machines, so it is not a customer's
 * own setting.
 */
@ApiTags('Vani')
@Controller('platform/vani/accounts')
export class VaniLinksController {
  constructor(private readonly links: VaniLinksService) {}

  @Get(':tenantId')
  @Requires('platform.admin')
  @ApiOperation({ summary: 'The Vani account a tenant is linked to, and its linked machines' })
  get(@Param('tenantId') tenantId: string) {
    return this.links.get(tenantId);
  }

  @Put(':tenantId')
  @Requires('platform.admin')
  @ApiOperation({ summary: 'Link a tenant to its Vani account, or replace the link. Idempotent; omitted fields are cleared' })
  putAccount(@Param('tenantId') tenantId: string, @Body() dto: VaniAccountLinkDto) {
    return this.links.putAccount(tenantId, dto);
  }

  @Delete(':tenantId')
  @Requires('platform.admin')
  @ApiOperation({ summary: 'Unlink a tenant from Vani, with all its machine links. Past calls are kept' })
  deleteAccount(@Param('tenantId') tenantId: string) {
    return this.links.deleteAccount(tenantId);
  }

  @Put(':tenantId/machines/:sourceSystem/:externalId')
  @Requires('platform.admin')
  @ApiOperation({ summary: 'Link one machine to its Vani machine id and spoken name, or replace the link. Idempotent' })
  putMachine(
    @Param('tenantId') tenantId: string,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Body() dto: VaniMachineLinkDto,
  ) {
    return this.links.putMachine(tenantId, sourceSystem, externalId, dto);
  }

  @Delete(':tenantId/machines/:sourceSystem/:externalId')
  @Requires('platform.admin')
  @ApiOperation({ summary: 'Unlink one machine from Vani' })
  deleteMachine(
    @Param('tenantId') tenantId: string,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.links.deleteMachine(tenantId, sourceSystem, externalId);
  }
}
