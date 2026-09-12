import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { RequestScope } from '../auth/types/request-scope';
import { capabilitiesFor } from '../auth/capabilities';

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
  @ApiOperation({ summary: 'Capabilities this caller has, for UI guards' })
  permissions(@CurrentScope() scope: RequestScope) {
    // Capabilities grow with each feature. Derived from roles today; the resource-level
    // check (can(action, resourceId)) arrives with the scope-aware data layer in P1-52.
    const has = (...roles: string[]) => roles.some((r) => scope.roles.includes(r));
    return {
      tenantId: scope.tenantId,
      capabilities: {
        'tenant.manage': has('super admin', 'master-admin'),
        'user.manage': has('super admin', 'master-admin'),
        'equipment.write': has('super admin', 'admin', 'master-admin'),
        'scenario.activate': has('super admin', 'admin'),
        'scenario.author': has('super admin', 'admin'),
        'alert.author': has('super admin', 'admin'),
        'action.work': has('super admin', 'admin', 'operational', 'support'),
        'catalog.write': has('master-admin', 'catalog-author'),
        'platform.admin': scope.isPlatformRole,
      },
    };
  }
}
