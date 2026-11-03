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

  @Get('sites/twins')
  @Requires('catalog.read')
  @ApiOperation({ summary: "Every laid-out site's twin in one call, for the port overview; sites not yet laid out are listed" })
  portTwin(@CurrentScope() scope: RequestScope) {
    return this.pages.portTwin(scope);
  }

  @Get('sites/:plantId/twin')
  @Requires('catalog.read')
  @ApiOperation({ summary: "One site's digital twin: layout, every machine with its live status, one model per class" })
  siteTwin(@CurrentScope() scope: RequestScope, @Param('plantId', ParseUUIDPipe) plantId: string) {
    return this.pages.siteTwin(scope, plantId);
  }

  @Get('sites/:plantId/twin/proposal')
  @Requires('catalog.read')
  @ApiOperation({ summary: "A first layout composed from the machines assigned to the site and their categories; not saved" })
  siteTwinProposal(@CurrentScope() scope: RequestScope, @Param('plantId', ParseUUIDPipe) plantId: string) {
    return this.pages.siteTwinProposal(scope, plantId);
  }
}
