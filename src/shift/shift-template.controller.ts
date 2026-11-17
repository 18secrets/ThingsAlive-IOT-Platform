import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ShiftService } from './services/shift.service';

class ApplyShiftTemplateDto {
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  templateSlug: string;
}

/**
 * The library's shift templates and applying one to a machine (fuel test report FU-3,
 * TC-FP-08). Reading is `catalog.read`, like the rest of the library; applying is
 * `equipment.write`, like typing a shift in by hand, because it is the same act.
 */
@ApiTags('Shifts')
@Controller()
export class ShiftTemplateController {
  constructor(private readonly shifts: ShiftService) {}

  @Get('shift-templates')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'The library\'s shift templates: named sets of shifts a machine can be given in one choice' })
  list(@CurrentScope() scope: RequestScope) {
    return this.shifts.templates(scope);
  }

  @Post('equipment/:sourceSystem/:externalId/shifts/from-template')
  @Requires('equipment.write')
  @ApiOperation({
    summary: 'Give this machine a template\'s shifts, as its own',
    description: 'Idempotent: a shift already there under the same name and hours is listed in alreadyThere and not '
      + 'written again. A same-named shift with other hours, or an overlap, is refused (409); nothing is overwritten.',
  })
  apply(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Body() body: ApplyShiftTemplateDto,
  ) {
    return this.shifts.applyTemplate(scope, { sourceSystem, externalId }, body.templateSlug);
  }
}
