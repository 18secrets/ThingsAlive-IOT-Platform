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
    // Computed by the same function CapabilityGuard enforces with. Two lists that
    // agree today are two lists that will disagree eventually, and the day they do,
    // the UI offers a control the API refuses — or hides one it would have allowed.
    return {
      tenantId: scope.tenantId,
      capabilities: capabilitiesFor(scope),
    };
  }
}
