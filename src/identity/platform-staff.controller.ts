import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsString } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { PLATFORM_ROLES, PlatformRole } from '../auth/platform-roles';
import { RequestScope } from '../auth/types/request-scope';
import { PlatformCredentialService } from './services/platform-credential.service';
import { PlatformStaffService } from './services/platform-staff.service';

export class InviteStaffDto {
  @IsEmail() email: string;
  @IsString() @IsNotEmpty() fullName: string;
  @IsIn([...PLATFORM_ROLES]) role: PlatformRole;
}

export class SetStaffRoleDto {
  @IsIn([...PLATFORM_ROLES]) role: PlatformRole;
}

export class SuspendStaffDto {
  @IsString() @IsNotEmpty() reason: string;
}

/**
 * Things Alive staff management (task QPA2) — master admin only.
 *
 * `staff:bootstrap` refuses a second run the moment any `platform_user` row exists;
 * this is what creates every one after the first. `platform.admin` is master-admin's
 * capability alone (`capabilities.ts`), so `@Requires('platform.admin')` already says
 * "master admin only" without a second, narrower rule to keep in step with the first.
 */
@ApiTags('Platform Staff')
@Controller('platform/staff')
export class PlatformStaffController {
  constructor(
    private readonly staff: PlatformStaffService,
    private readonly credentials: PlatformCredentialService,
  ) {}

  @Get()
  @Requires('platform.admin')
  @ApiOperation({ summary: 'Every Things Alive staff member, with role and status' })
  list() {
    return this.staff.list();
  }

  @Post()
  @Requires('platform.admin')
  @ApiOperation({ summary: 'Invite a staff member. The role is part of the invitation, not a later step' })
  async invite(@CurrentScope() scope: RequestScope, @Body() body: InviteStaffDto) {
    const user = await this.staff.invite(body, scope.userId);
    // Composed rather than done inside PlatformStaffService: the invited row and the
    // token that lets somebody claim it are different concerns, the same split
    // IdentityController keeps between UserService and CredentialService.
    const { token, expiresAt } = await this.credentials.issueInvitation(user.id, scope.userId);
    return { ...user, invitationToken: token, invitationExpiresAt: expiresAt };
  }

  @Put(':id/role')
  @Requires('platform.admin')
  @ApiOperation({ summary: 'Move somebody to a different platform role' })
  setRole(@Param('id') id: string, @Body() body: SetStaffRoleDto) {
    return this.staff.setRole(id, body.role);
  }

  @Post(':id/suspend')
  @Requires('platform.admin')
  @ApiOperation({ summary: 'Stop somebody signing in, keeping everything they did' })
  suspend(@Param('id') id: string, @Body() body: SuspendStaffDto) {
    return this.staff.suspend(id, body.reason);
  }

  @Post(':id/reinstate')
  @Requires('platform.admin')
  @ApiOperation({ summary: 'Let them back in' })
  reinstate(@Param('id') id: string) {
    return this.staff.reinstate(id);
  }
}
