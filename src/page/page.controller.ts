import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { PageService } from './page.service';

/**
 * The composed pages (task QPAGE1, D29): the whole page in one call, so the console
 * never needs a second request per widget. Same capability as the per-KPI route it
 * composes (`kpi.controller.ts`).
 */
@ApiTags('Pages')
@Controller()
export class PageController {
  constructor(private readonly pages: PageService) {}

  @Get('equipment/:sourceSystem/:externalId/page')
  @Requires('catalog.read')
  @ApiOperation({ summary: "One machine's page: every widget, filled or saying why not" })
  machinePage(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.pages.machinePage(scope, { sourceSystem, externalId });
  }

  @Get('sites/:plantId/page')
  @Requires('catalog.read')
  @ApiOperation({ summary: "One site's page, from its site class or the platform default" })
  sitePage(@CurrentScope() scope: RequestScope, @Param('plantId', ParseUUIDPipe) plantId: string) {
    return this.pages.sitePage(scope, plantId);
  }
}
