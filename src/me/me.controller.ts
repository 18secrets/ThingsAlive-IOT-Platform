import { Body, Controller, Get, Headers, Ip, Optional, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { RequestScope } from '../auth/types/request-scope';
import { capabilitiesFor } from '../auth/capabilities';
import { RoleService } from '../identity/services/role.service';
import { CredentialService } from '../identity/services/credential.service';
import { PlatformCredentialService } from '../identity/services/platform-credential.service';

export class ChangePasswordDto {
  @IsString() @IsNotEmpty() currentPassword: string;
  @IsString() @IsNotEmpty() newPassword: string;
}

/**
 * What the caller is, and what they may do.
 *
 * The UI reads this instead of comparing role strings inside components
 * (task P1-57). The permission list is derived on the server, so a screen can
 * never grant itself something the API would refuse.
 */
@ApiTags('Me')
@Controller('me')
export class MeController {
  // Optional: MeController is registered even when the app boots with no database
  // (see AppModule's `withDatabase` gate, used by the contract/wiring suites), and
  // IdentityModule — which provides this — is only imported when one is present.
  constructor(
    @Optional() private readonly roles?: RoleService,
    @Optional() private readonly credentials?: CredentialService,
    @Optional() private readonly platformCredentials?: PlatformCredentialService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The resolved scope for this token' })
  me(@CurrentScope() scope: RequestScope) {
    return {
      tenantId: scope.tenantId,
      userId: scope.userId,
      roles: scope.roles,
      isPlatformRole: scope.isPlatformRole,
      scope: {
        plants: scope.plantIds ?? 'unrestricted',
        equipment: scope.equipmentIds ?? 'unrestricted',
        devices: scope.deviceIds ?? 'unrestricted',
      },
    };
  }

  @Get('permissions')
  @ApiOperation({ summary: 'Capabilities and page access this caller has, for UI guards' })
  async permissions(@CurrentScope() scope: RequestScope) {
    // Computed by the same function CapabilityGuard enforces with. Two lists that
    // agree today are two lists that will disagree eventually, and the day they do,
    // the UI offers a control the API refuses — or hides one it would have allowed.
    return {
      tenantId: scope.tenantId,
      capabilities: capabilitiesFor(scope),
      // Which pages this caller's own role grants — empty for a platform role
      // (no page-access system yet) or when the app has no database at all.
      allowedTabs: (await this.roles?.myAllowedTabs(scope)) ?? [],
    };
  }

  @Post('change-password')
  @ApiOperation({ summary: "Change the signed-in caller's own password" })
  async changePassword(
    @CurrentScope() scope: RequestScope,
    @Body() body: ChangePasswordDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const ctx = { ipAddress: ip, userAgent };
    if (scope.isPlatformRole) {
      await this.platformCredentials?.changeOwnPassword(scope.userId, body.currentPassword, body.newPassword, ctx);
    } else {
      await this.credentials?.changeOwnPassword(scope, body.currentPassword, body.newPassword, ctx);
    }
    // Every session — including this request's own refresh token — is revoked as
    // part of the change (see CredentialService.changeOwnPassword's own comment), so
    // the caller signs in again rather than limping along on an access token that
    // cannot be renewed.
    return { changed: true };
  }
}
