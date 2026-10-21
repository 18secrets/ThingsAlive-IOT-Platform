import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ModelAnchorSetDto } from '../catalog/class-model.controller';
import { ClientModelService } from './services/client-model.service';

/** The account's 3-D twin (task QTWIN1 §3): read by everyone in the tenant, its markers
 * placed and confirmed by the super admin. */
@ApiTags('Client catalog')
@Controller('my-catalog/equipment-classes/:slug/model')
export class ClientModelController {
  constructor(private readonly models: ClientModelService) {}

  @Get()
  @Requires('client-catalog.read')
  @ApiOperation({ summary: "This account's 3-D model, its markers, and the tray: unplaced signals and markers to recheck" })
  read(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.models.read(scope, slug);
  }

  @Put('anchors')
  @Requires('client-catalog.write')
  @ApiOperation({ summary: "Replace this account's whole model anchor set. Moved or added anchors become the account's own" })
  replaceAnchors(@CurrentScope() scope: RequestScope, @Param('slug') slug: string, @Body() dto: ModelAnchorSetDto) {
    return this.models.replaceAnchors(scope, slug, dto.anchors.map((a) => ({ ...a, label: a.label ?? null })));
  }

  @Post('anchors/:signal/confirm')
  @HttpCode(200)
  @Requires('client-catalog.write')
  @ApiOperation({ summary: 'Confirm a marker the geometry changed under is still right. Idempotent' })
  confirm(@CurrentScope() scope: RequestScope, @Param('slug') slug: string, @Param('signal') signal: string) {
    return this.models.confirmAnchor(scope, slug, signal);
  }
}
