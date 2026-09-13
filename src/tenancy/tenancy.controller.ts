import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';
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
}

export class ProvisionDto {
  @IsString() @IsNotEmpty() tenantId: string;
  @IsString() @IsNotEmpty() name: string;
  @IsOptional() @IsString() plan?: string;
  @IsOptional() @IsString() region?: string;
  superAdmin: SuperAdminDto;
  @IsOptional() @IsArray() @ArrayMaxSize(50) externalClients?: ExternalClientDto[];
}

export class SuspendTenantDto {
  @IsString() @IsNotEmpty() reason: string;
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
