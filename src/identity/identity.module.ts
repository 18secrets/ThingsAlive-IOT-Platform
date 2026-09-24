import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SCOPE_RESOLVER } from '../auth/scope-resolver';
import { PLATFORM_SESSION_VALIDATOR } from '../auth/platform-session-validator';
import { AppUser } from './entities/app-user.entity';
import { TenantRole } from './entities/tenant-role.entity';
import { UserEquipmentAccess, UserPlantAccess } from './entities/user-access.entity';
import { UserInvitation } from './entities/user-invitation.entity';
import { UserSecurityEvent } from './entities/user-security-event.entity';
import { UserSession } from './entities/user-session.entity';
import { PlatformUser } from './entities/platform-user.entity';
import { PlatformSession } from './entities/platform-session.entity';
import { PlatformInvitation } from './entities/platform-invitation.entity';
import { AuthController } from './auth.controller';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformStaffController } from './platform-staff.controller';
import { IdentityController } from './identity.controller';
import { CredentialService } from './services/credential.service';
import { PlatformCredentialService } from './services/platform-credential.service';
import { PlatformSessionValidatorService } from './services/platform-session-validator.service';
import { PlatformStaffService } from './services/platform-staff.service';
import { PasswordService } from './services/password.service';
import { RoleService } from './services/role.service';
import { ScopeResolverService } from './services/scope-resolver.service';
import { UserService } from './services/user.service';

/**
 * Identity, provided to the guard through a token rather than an import.
 *
 * The auth module cannot depend on this one — it is what protects it — so the guard
 * asks for a `SCOPE_RESOLVER` and this module supplies one. Without the module the
 * guard still works and falls back to the token, which is how the contract and
 * isolation suites run with no identity database at all.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TenantRole, AppUser, UserPlantAccess, UserEquipmentAccess,
      UserInvitation, UserSession, UserSecurityEvent,
      PlatformUser, PlatformSession, PlatformInvitation,
    ]),
    JwtModule.register({}),
  ],
  controllers: [IdentityController, AuthController, PlatformAuthController, PlatformStaffController],
  providers: [
    UserService,
    RoleService,
    PasswordService,
    CredentialService,
    PlatformCredentialService,
    PlatformStaffService,
    ScopeResolverService,
    PlatformSessionValidatorService,
    { provide: SCOPE_RESOLVER, useExisting: ScopeResolverService },
    { provide: PLATFORM_SESSION_VALIDATOR, useExisting: PlatformSessionValidatorService },
  ],
  exports: [
    UserService, RoleService, CredentialService, PlatformCredentialService, PlatformStaffService, PasswordService,
    SCOPE_RESOLVER, PLATFORM_SESSION_VALIDATOR,
  ],
})
export class IdentityModule {}
