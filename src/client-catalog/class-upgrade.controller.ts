import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ClassUpgradeService } from './services/class-upgrade.service';

export class ApplyUpgradeDto {
  /** The version the tenant reviewed. Refused if a newer one has published since. */
  @IsInt() @Min(1) toVersion: number;
}

/**
 * Moving the account's copy of a class to the latest published version (task
 * QUPGRADE1). Read the diff, then apply exactly that version. Inherited content
 * follows the library; anything the tenant changed or added is kept.
 */
@ApiTags('Client catalog')
@Controller('my-catalog/equipment-classes/:slug/upgrade')
export class ClassUpgradeController {
  constructor(private readonly upgrades: ClassUpgradeService) {}

  @Get()
  @Requires('client-catalog.read')
  @ApiOperation({ summary: 'What upgrading to the latest published version would change' })
  preview(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.upgrades.preview(scope, slug);
  }

  @Post()
  @HttpCode(200)
  @Requires('client-catalog.write')
  @ApiOperation({ summary: 'Apply the upgrade reviewed. Idempotent: a repeat is a no-op that says so' })
  apply(@CurrentScope() scope: RequestScope, @Param('slug') slug: string, @Body() body: ApplyUpgradeDto) {
    return this.upgrades.apply(scope, slug, body.toVersion);
  }
}
