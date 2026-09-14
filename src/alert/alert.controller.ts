import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { Severity, SEVERITY_ORDER } from '../common/severity';
import { AlertAppliesTo } from './entities/alert-rule.entity';
import { AlertParams, AlertTrigger } from './services/alert-rules';
import { AlertService } from './services/alert.service';

const TRIGGERS = ['prediction-severity', 'signal-threshold', 'no-telemetry', 'fuel-loss'];
const APPLIES = ['account', 'plant', 'equipment'];

export class RuleDto {
  @IsString() @IsNotEmpty() slug: string;
  @IsString() @IsNotEmpty() name: string;
  @IsOptional() @IsString() description?: string;
  @IsIn(TRIGGERS) trigger: AlertTrigger;
  @IsObject() params: AlertParams;
  @IsOptional() @IsIn(APPLIES) appliesTo?: AlertAppliesTo;
  @IsOptional() @IsUUID() plantId?: string;
  @IsOptional() @IsString() sourceSystem?: string;
  @IsOptional() @IsString() externalId?: string;
  @IsOptional() @IsIn(SEVERITY_ORDER as unknown as string[]) severity?: Severity;
}

export class RulePatchDto {
  @IsOptional() @IsString() slug?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsIn(TRIGGERS) trigger?: AlertTrigger;
  @IsOptional() @IsObject() params?: AlertParams;
  @IsOptional() @IsIn(APPLIES) appliesTo?: AlertAppliesTo;
  @IsOptional() @IsUUID() plantId?: string;
  @IsOptional() @IsString() sourceSystem?: string;
  @IsOptional() @IsString() externalId?: string;
  @IsOptional() @IsIn(SEVERITY_ORDER as unknown as string[]) severity?: Severity;
}

export class ResolveDto {
  @IsString() @IsNotEmpty() note: string;
}

/**
 * Alerts (task P1-119).
 *
 * Authoring is behind `alert.author`, which until now was granted to every client
 * role and required by no route.
 *
 * Reading and working alerts deliberately reuse `prediction.read` and `action.work`
 * rather than adding two more capabilities. An alert is the same class of thing as a
 * prediction — what the platform is telling you about your machines — and clearing one
 * is the same class of act as working a job. Every client role already holds both, so
 * two new capabilities would have been granted to everybody on day one and would have
 * meant one more thing for an administrator to read and nothing for them to decide.
 */
@ApiTags('Alerts')
@Controller('alerts')
export class AlertController {
  constructor(private readonly alerts: AlertService) {}

  @Get()
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Alerts on the machines you can see' })
  list(
    @CurrentScope() scope: RequestScope,
    @Query('state') state?: string,
    @Query('equipment') equipment?: string,
  ) {
    return this.alerts.listEvents(scope, {
      state: state ? state.split(',') : undefined,
      externalId: equipment,
    });
  }

  @Post(':id/acknowledge')
  @Requires('action.work')
  @ApiOperation({ summary: 'I have seen this' })
  acknowledge(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.alerts.acknowledge(scope, id);
  }

  @Post(':id/resolve')
  @Requires('action.work')
  @ApiOperation({ summary: 'This is dealt with, and here is what was found' })
  resolve(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: ResolveDto) {
    return this.alerts.resolve(scope, id, body.note);
  }

  @Get('rules')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'The rules this account has written' })
  listRules(@CurrentScope() scope: RequestScope) {
    return this.alerts.listRules(scope);
  }

  @Post('rules')
  @Requires('alert.author')
  @ApiOperation({ summary: 'Ask to be told when something is true' })
  createRule(@CurrentScope() scope: RequestScope, @Body() body: RuleDto) {
    return this.alerts.createRule(scope, body);
  }

  @Patch('rules/:id')
  @Requires('alert.author')
  @ApiOperation({ summary: 'Change a rule. Alerts it already raised keep their wording' })
  updateRule(
    @CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: RulePatchDto,
  ) {
    return this.alerts.updateRule(scope, id, body);
  }

  @Post('rules/:id/disable')
  @Requires('alert.author')
  @ApiOperation({ summary: 'Stop it firing, without losing what it explained' })
  disable(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.alerts.setEnabled(scope, id, false);
  }

  @Post('rules/:id/enable')
  @Requires('alert.author')
  @ApiOperation({ summary: 'Start it again' })
  enable(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.alerts.setEnabled(scope, id, true);
  }
}
