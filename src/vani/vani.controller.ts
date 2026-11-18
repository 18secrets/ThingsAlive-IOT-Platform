import { Body, Controller, Get, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { checkVaniSecret } from './vani-secret';
import { VaniAskService } from './vani-ask.service';
import { VaniOutcomeService } from './vani-outcome.service';

/**
 * Vani, the voice agent that phones customers about alerts (integration guide §6.3).
 *
 * Reading call history reuses `prediction.read`, as reading alerts does: a call is
 * one more way the platform told somebody about their machine.
 */
@ApiTags('Vani')
@Controller('vani')
export class VaniController {
  constructor(private readonly outcomes: VaniOutcomeService, private readonly analysis: VaniAskService) {}

  @Post('ask')
  @HttpCode(200)
  @Public('Vani asks on a caller\'s behalf and holds no user token; it proves itself with X-Vani-Secret, and the answer is scoped to the caller found by phone number.')
  @ApiOperation({ summary: 'Vani asks the platform a question for the person on the phone, and gets only the answer' })
  async ask(@Headers('x-vani-secret') secret: string | undefined, @Body() body: unknown) {
    checkVaniSecret(secret);
    return this.analysis.ask(body);
  }

  @Post('outcome-callback')
  @HttpCode(200)
  @Public('Vani posts call outcomes here and holds no user token; it proves itself with X-Vani-Secret.')
  @ApiOperation({ summary: 'Vani reports what happened on one call attempt' })
  async callback(@Headers('x-vani-secret') secret: string | undefined, @Body() body: unknown) {
    this.outcomes.checkSecret(secret);
    return this.outcomes.record(body);
  }

  @Get('calls')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Calls Vani was asked to make about your alerts, and what happened on each' })
  calls(
    @CurrentScope() scope: RequestScope,
    @Query('alert') alertEventId?: string,
    @Query('equipment') externalId?: string,
  ) {
    return this.outcomes.list(scope, { alertEventId, externalId });
  }
}
