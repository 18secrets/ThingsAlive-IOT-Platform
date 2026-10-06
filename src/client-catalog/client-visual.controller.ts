import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { AnchorSetDto } from '../catalog/class-visual.controller';
import { ClientVisualService } from './services/client-visual.service';

/** The account's class visual (task QREC0c §4): read by everyone in the tenant, its
 * anchors placed by the super admin. */
@ApiTags('Client catalog')
@Controller('my-catalog/equipment-classes/:slug')
export class ClientVisualController {
  constructor(private readonly visuals: ClientVisualService) {}

  @Get('visual')
  @Requires('client-catalog.read')
  @ApiOperation({ summary: "This account's class visual, its anchors, and the signals not yet placed" })
  read(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.visuals.read(scope, slug);
  }

  @Put('anchors')
  @Requires('client-catalog.write')
  @ApiOperation({ summary: "Replace this account's whole anchor set. Moved or added anchors become the account's own" })
  replaceAnchors(@CurrentScope() scope: RequestScope, @Param('slug') slug: string, @Body() dto: AnchorSetDto) {
    return this.visuals.replaceAnchors(scope, slug, dto.anchors.map((a) => ({ ...a, label: a.label ?? null })));
  }
}
