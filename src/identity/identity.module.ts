import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SCOPE_RESOLVER } from '../auth/scope-resolver';
import { AppUser } from './entities/app-user.entity';
import { TenantRole } from './entities/tenant-role.entity';
import { UserEquipmentAccess, UserPlantAccess } from './entities/user-access.entity';
import { IdentityController } from './identity.controller';
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
  imports: [TypeOrmModule.forFeature([TenantRole, AppUser, UserPlantAccess, UserEquipmentAccess])],
  controllers: [IdentityController],
  providers: [
    UserService,
    RoleService,
    ScopeResolverService,
    { provide: SCOPE_RESOLVER, useExisting: ScopeResolverService },
  ],
  exports: [UserService, RoleService, SCOPE_RESOLVER],
})
export class IdentityModule {}
