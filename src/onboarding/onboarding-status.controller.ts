import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { OnboardingStatusService } from './onboarding-status.service';

const STEP_EXAMPLE = [
  { step: 'equipment', state: 'done', reason: null, blockedBy: null, evidence: { classSlug: 'demo-excavator', classVersion: 1 } },
  { step: 'device', state: 'done', reason: null, blockedBy: null, evidence: { imeis: ['358000000000600'] } },
  { step: 'mapping', state: 'pending', reason: 'unbound', blockedBy: null,
    evidence: { required: 5, bound: 4, unbound: ['fuel_level'], mappingRequired: [] } },
  { step: 'validation', state: 'blocked', reason: 'blocked_by_step', blockedBy: 'mapping', evidence: {} },
  { step: 'activation', state: 'blocked', reason: 'blocked_by_step', blockedBy: 'mapping', evidence: { active: 0, notActive: 0 } },
  { step: 'alerts', state: 'done', reason: null, blockedBy: null, evidence: { rules: ['demo-excavator-coolant-high'] } },
  { step: 'access', state: 'pending', reason: 'no_user_access', blockedBy: null, evidence: { usersByEquipmentGrant: 0, usersBySiteGrant: 0 } },
];

/**
 * Onboarding progress (task QONBOARD-STATUS): derived from the tables that own each
 * fact, never stored. Read-only — every step is completed on the page that already
 * owns it. Gated by `equipment.write`: the checklist is for the people who can act on
 * it, and an operator shown a setup list they cannot complete learns nothing.
 */
@ApiTags('Onboarding')
@Controller('onboarding/status')
export class OnboardingStatusController {
  constructor(private readonly status: OnboardingStatusService) {}

  @Get()
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Per site: machines done and in progress, and per step how many are done / pending / blocked' })
  @ApiOkResponse({
    schema: {
      example: {
        asOf: '2026-10-12T07:00:00.000Z',
        sites: [{
          site: { id: '6f1c…', code: 'PUNE-01', name: 'Pune yard' },
          status: 'in_progress',
          machines: { total: 6, done: 4, inProgress: 2 },
          steps: { mapping: { done: 5, pending: 1, blocked: 0 }, validation: { done: 4, pending: 1, blocked: 1 } },
        }],
      },
    },
  })
  summary(@CurrentScope() scope: RequestScope) {
    return this.status.summary(scope);
  }

  @Get('equipment/:sourceSystem/:externalId')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'The seven steps for one machine: state, reason, the step it waits on, and the evidence' })
  @ApiOkResponse({
    schema: {
      example: {
        machine: { sourceSystem: 'seed-demo', externalId: 'EX-06', name: 'EX-06 Partly unbound', classSlug: 'demo-excavator', plantId: '6f1c…' },
        overall: 'in_progress',
        steps: STEP_EXAMPLE,
      },
    },
  })
  machine(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.status.machine(scope, sourceSystem, externalId);
  }
}
