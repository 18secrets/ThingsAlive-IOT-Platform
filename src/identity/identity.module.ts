import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SCOPE_RESOLVER } from '../auth/scope-resolver';
import { AppUser } from './entities/app-user.entity';
import { TenantRole } from './entities/tenant-role.entity';
import { UserEquipmentAccess, UserPlantAccess } from './entities/user-access.entity';
import { UserInvitation } from './entities/user-invitation.entity';
import { UserSecurityEvent } from './entities/user-security-event.entity';
import { UserSession } from './entities/user-session.entity';
import { PlatformUser } from './entities/platform-user.entity';
import { PlatformSession } from './entities/platform-session.entity';
import { AuthController } from './auth.controller';
import { IdentityController } from './identity.controller';
import { CredentialService } from './services/credential.service';
import { PlatformCredentialService } from './services/platform-credential.service';
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
      UserInvitation, UserSession, UserSecurityEvent, PlatformUser, PlatformSession,
    ]),
    JwtModule.register({}),
  ],
  controllers: [IdentityController, AuthController],
  providers: [
    UserService,
    RoleService,
    PasswordService,
    CredentialService,
    PlatformCredentialService,
    ScopeResolverService,
    { provide: SCOPE_RESOLVER, useExisting: ScopeResolverService },
  ],
  exports: [
    UserService, RoleService, CredentialService, PlatformCredentialService, PasswordService, SCOPE_RESOLVER,
  ],
})
export class IdentityModule {}
