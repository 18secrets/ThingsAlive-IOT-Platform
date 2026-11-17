import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { SiteDraftDto } from '../site-twin/site-twin.controller';
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

  @Get('equipment/:sourceSystem/:externalId/live')
  @Requires('catalog.read')
  @ApiOperation({ summary: "One machine as it is now: each signal's newest value and age, connection, running and position (read from 1.0 at request time when connected)" })
  machineLive(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.pages.machineLive(scope, { sourceSystem, externalId });
  }

  @Get('equipment/:sourceSystem/:externalId/events')
  @Requires('catalog.read')
  @ApiOperation({ summary: "One machine's starts, trips and voltage events over a window (default the last day, at most 7 days), newest first" })
  machineEvents(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.pages.machineEvents(scope, { sourceSystem, externalId }, parseDate(from, 'from'), parseDate(to, 'to'));
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

  // A POST only because the draft is a body; nothing is written, so it needs no more than
  // the GET beside it, and it answers 200, not 201.
  @Post('sites/:plantId/twin/proposal')
  @HttpCode(200)
  @Requires('catalog.read')
  @ApiOperation({ summary: "Arrange the site's machines around the editor's draft: its zones kept as drawn, only missing structures added; not saved" })
  siteTwinProposalAround(
    @CurrentScope() scope: RequestScope,
    @Param('plantId', ParseUUIDPipe) plantId: string,
    @Body() body: SiteDraftDto,
  ) {
    return this.pages.siteTwinProposal(scope, plantId, new Date(), body);
  }
}

/** Unreadable is refused, not dropped: an Invalid Date silently matches nothing. */
function parseDate(raw: string | undefined, field: string): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`${field} is not a date I can read: "${raw}".`);
  return parsed;
}
