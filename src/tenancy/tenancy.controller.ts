import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsEmail, IsNotEmpty, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ProvisioningService } from './services/provisioning.service';

export class ExternalClientDto {
  @IsString() @IsNotEmpty() sourceSystem: string;
  @IsString() @IsNotEmpty() externalClientId: string;
}

export class SuperAdminDto {
  @IsEmail() email: string;
  @IsString() @IsNotEmpty() fullName: string;
  @IsOptional() @IsString() phone?: string;
}

export class ProvisionDto {
  @IsString() @IsNotEmpty() tenantId: string;
  @IsString() @IsNotEmpty() name: string;
  @IsOptional() @IsString() plan?: string;
  @IsOptional() @IsString() region?: string;
  // Without @ValidateNested the property carries no validation metadata at all, and a
  // whitelisting pipe does not ignore such a property — it strips it, then refuses the
  // request for containing it. This route was unusable in production for exactly that
  // reason while every test passed, because the tests call the service directly.
  @ValidateNested() @Type(() => SuperAdminDto) superAdmin: SuperAdminDto;
  @IsOptional() @IsArray() @ArrayMaxSize(50)
  @ValidateNested({ each: true }) @Type(() => ExternalClientDto)
  externalClients?: ExternalClientDto[];
}

export class SuspendTenantDto {
  @IsString() @IsNotEmpty() reason: string;
}

export class SuperAdminUpdateDto {
  @IsOptional() @IsString() @IsNotEmpty() fullName?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
}

export class UpdateAccountDto {
  @IsOptional() @IsString() @IsNotEmpty() name?: string;
  @IsOptional() @IsString() plan?: string;
  @IsOptional() @IsString() region?: string;
  // Same @ValidateNested requirement as ProvisionDto.superAdmin — without it a
  // whitelisting pipe strips this object and then refuses the request for
  // carrying an unrecognised property.
  @IsOptional() @ValidateNested() @Type(() => SuperAdminUpdateDto) superAdmin?: SuperAdminUpdateDto;
}

/**
 * Standing an account up and taking it down (task P1-89).
 *
 * Things Alive only. This and seeding the first administrator are the whole of what
 * the platform does inside a customer's account — everything after it is theirs.
 */
@ApiTags('Accounts')
@Controller('accounts')
export class TenancyController {
  constructor(private readonly provisioning: ProvisioningService) {}

  @Get()
  @Requires('tenant.provision')
  @ApiOperation({ summary: 'Every account Things Alive has provisioned' })
  list(@CurrentScope() scope: RequestScope) {
    return this.provisioning.list(scope);
  }

  @Get(':tenantId')
  @Requires('tenant.provision')
  @ApiOperation({ summary: 'One account' })
  get(@CurrentScope() scope: RequestScope, @Param('tenantId') tenantId: string) {
    return this.provisioning.get(scope, tenantId);
  }

  @Post()
  @Requires('tenant.provision')
  @ApiOperation({ summary: 'Create an account, its roles and its first administrator, in one transaction' })
  provision(@CurrentScope() scope: RequestScope, @Body() body: ProvisionDto) {
    return this.provisioning.provision(scope, body);
  }

  @Patch(':tenantId')
  @Requires('tenant.provision')
  @ApiOperation({ summary: "Change an account's name/plan/region or its super admin's contact details" })
  update(
    @CurrentScope() scope: RequestScope,
    @Param('tenantId') tenantId: string,
    @Body() body: UpdateAccountDto,
  ) {
    return this.provisioning.update(scope, tenantId, body);
  }

  @Post(':tenantId/resend-invitation')
  @Requires('tenant.provision')
  @ApiOperation({ summary: 'Reissue the super admin\'s invitation — only while it has never been accepted' })
  resendInvitation(@CurrentScope() scope: RequestScope, @Param('tenantId') tenantId: string) {
    return this.provisioning.resendInvitation(scope, tenantId);
  }

  @Post(':tenantId/suspend')
  @Requires('tenant.provision')
  @ApiOperation({ summary: 'Stop every sign-in for this account without touching its users' })
  suspend(
    @CurrentScope() scope: RequestScope,
    @Param('tenantId') tenantId: string,
    @Body() body: SuspendTenantDto,
  ) {
    return this.provisioning.suspend(scope, tenantId, body.reason);
  }

  @Post(':tenantId/reinstate')
  @Requires('tenant.provision')
  @ApiOperation({ summary: 'Let the account back in, exactly as it was' })
  reinstate(@CurrentScope() scope: RequestScope, @Param('tenantId') tenantId: string) {
    return this.provisioning.reinstate(scope, tenantId);
  }
}
