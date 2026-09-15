import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ScopeShape } from './entities/tenant-role.entity';
import { RoleService } from './services/role.service';
import { UserService } from './services/user.service';

export class PlantRefDto {
  @IsString() @IsNotEmpty() plantId: string;
}

export class EquipmentRefDto {
  @IsString() @IsNotEmpty() sourceSystem: string;
  @IsString() @IsNotEmpty() equipmentExternalId: string;
}

export class InviteDto {
  @IsEmail() email: string;
  @IsString() @IsNotEmpty() fullName: string;
  @IsString() @IsNotEmpty() roleSlug: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(500)
  @ValidateNested({ each: true }) @Type(() => PlantRefDto) plants?: PlantRefDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(2000)
  @ValidateNested({ each: true }) @Type(() => EquipmentRefDto) equipment?: EquipmentRefDto[];
}

export class AccessDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500)
  @ValidateNested({ each: true }) @Type(() => PlantRefDto) plants?: PlantRefDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(2000)
  @ValidateNested({ each: true }) @Type(() => EquipmentRefDto) equipment?: EquipmentRefDto[];
}

export class RoleDto {
  @IsString() @IsNotEmpty() slug: string;
  @IsString() @IsNotEmpty() name: string;
  @IsOptional() @IsString() description?: string;
  @IsArray() @IsString({ each: true }) capabilities: string[];
  @IsIn(['tenant', 'plant', 'equipment']) scopeShape: ScopeShape;
}

export class RolePatchDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) capabilities?: string[];
  @IsOptional() @IsIn(['tenant', 'plant', 'equipment']) scopeShape?: ScopeShape;
}

export class SuspendDto {
  @IsString() @IsNotEmpty() reason: string;
}

export class SetRoleDto {
  @IsString() @IsNotEmpty() roleSlug: string;
}

/**
 * The account's people and its roles (task P1-21).
 *
 * Every route here is the client's own super admin acting inside their account.
 * Nothing on this controller is available to a platform role, which is the same
 * boundary that keeps Things Alive out of a client's catalog copies: who works for a
 * customer is not ours to decide.
 */
@ApiTags('Identity')
@Controller('identity')
export class IdentityController {
  constructor(
    private readonly users: UserService,
    private readonly roles: RoleService,
  ) {}

  @Get('roles')
  @Requires('role.manage')
  @ApiOperation({ summary: "This account's roles and what each one may do" })
  listRoles(@CurrentScope() scope: RequestScope) {
    return this.roles.list(scope);
  }

  @Post('roles')
  @Requires('role.manage')
  @ApiOperation({ summary: 'Add a role, composed from the capabilities the API checks' })
  createRole(@CurrentScope() scope: RequestScope, @Body() body: RoleDto) {
    return this.roles.create(scope, body);
  }

  @Patch('roles/:slug')
  @Requires('role.manage')
  @ApiOperation({ summary: 'Rename a role or change what it may do. The slug never moves' })
  updateRole(
    @CurrentScope() scope: RequestScope,
    @Param('slug') slug: string,
    @Body() body: RolePatchDto,
  ) {
    return this.roles.update(scope, slug, body);
  }

  @Delete('roles/:slug')
  @Requires('role.manage')
  @ApiOperation({ summary: 'Remove a role nobody holds' })
  removeRole(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.roles.remove(scope, slug);
  }

  @Get('users')
  @Requires('user.manage')
  @ApiOperation({ summary: 'Everyone in this account, with their role and assignments' })
  listUsers(@CurrentScope() scope: RequestScope) {
    return this.users.list(scope);
  }

  @Post('users')
  @Requires('user.manage')
  @ApiOperation({ summary: 'Invite somebody. The role is part of the invitation, not a later step' })
  invite(@CurrentScope() scope: RequestScope, @Body() body: InviteDto) {
    return this.users.invite(scope, body);
  }

  @Put('users/:id/role')
  @Requires('user.manage')
  @ApiOperation({ summary: 'Move somebody to a different role' })
  setRole(
    @CurrentScope() scope: RequestScope,
    @Param('id') id: string,
    @Body() body: SetRoleDto,
  ) {
    return this.users.setRole(scope, id, body.roleSlug);
  }

  @Put('users/:id/access')
  @Requires('user.manage')
  @ApiOperation({ summary: 'Replace which sites and machines this person is assigned to' })
  setAccess(
    @CurrentScope() scope: RequestScope,
    @Param('id') id: string,
    @Body() body: AccessDto,
  ) {
    return this.users.setAccess(scope, id, body);
  }

  @Post('users/:id/suspend')
  @Requires('user.manage')
  @ApiOperation({ summary: 'Stop somebody signing in, keeping everything they did' })
  suspend(
    @CurrentScope() scope: RequestScope,
    @Param('id') id: string,
    @Body() body: SuspendDto,
  ) {
    return this.users.suspend(scope, id, body.reason);
  }

  @Post('users/:id/reinstate')
  @Requires('user.manage')
  @ApiOperation({ summary: 'Let them back in' })
  reinstate(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.users.reinstate(scope, id);
  }
}
