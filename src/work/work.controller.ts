import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { WorkOrderPriority } from './entities/work-order.entity';
import { WorkOrderService } from './services/work-order.service';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export class RaiseDto {
  @IsString() @IsNotEmpty() sourceSystem: string;
  @IsString() @IsNotEmpty() externalId: string;
  @IsString() @IsNotEmpty() title: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsIn(PRIORITIES as unknown as string[]) priority?: WorkOrderPriority;
  @IsOptional() @IsUUID() assignedToUserId?: string;
  @IsOptional() @IsUUID() predictionId?: string;
  @IsOptional() @IsISO8601() dueAt?: string;
}

export class EditDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsIn(PRIORITIES as unknown as string[]) priority?: WorkOrderPriority;
  @IsOptional() @IsISO8601() dueAt?: string;
}

export class AssignDto {
  /** Null takes it back off whoever holds it. */
  @IsOptional() @IsUUID() userId?: string | null;
  @IsOptional() @IsString() note?: string;
}

export class NoteDto {
  @IsOptional() @IsString() note?: string;
}

/**
 * Jobs on machines (task P1-87).
 *
 * `action.work` finally does something: until this controller existed it was a
 * capability every client role was granted and no route required, which is the exact
 * failure the capability union was built to make impossible and had quietly allowed
 * anyway — granted, plausible, and reading as permission to do something that could
 * not be done.
 */
@ApiTags('Work orders')
@Controller('work-orders')
export class WorkOrderController {
  constructor(private readonly orders: WorkOrderService) {}

  @Get()
  @Requires('action.work')
  @ApiOperation({ summary: 'Jobs on the machines you can see' })
  list(
    @CurrentScope() scope: RequestScope,
    @Query('status') status?: string,
    @Query('equipment') equipment?: string,
    @Query('mine') mine?: string,
  ) {
    return this.orders.list(scope, {
      status: status ? status.split(',') : undefined,
      externalId: equipment,
      mine: mine === 'true',
    });
  }

  @Post()
  @Requires('action.assign')
  @ApiOperation({ summary: 'Raise a job against a machine' })
  raise(@CurrentScope() scope: RequestScope, @Body() body: RaiseDto) {
    return this.orders.raise(scope, {
      ...body,
      dueAt: body.dueAt ? new Date(body.dueAt) : null,
    });
  }

  @Get(':id/history')
  @Requires('action.work')
  @ApiOperation({ summary: 'What happened to this job, and who did it' })
  history(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.orders.history(scope, id);
  }

  @Patch(':id')
  @Requires('action.assign')
  @ApiOperation({ summary: 'Edit a job. Status and assignment have their own routes' })
  edit(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: EditDto) {
    return this.orders.update(scope, id, {
      ...body,
      dueAt: body.dueAt ? new Date(body.dueAt) : undefined,
    });
  }

  @Post(':id/assign')
  @Requires('action.assign')
  @ApiOperation({ summary: 'Hand the job to somebody, or take it back' })
  assign(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: AssignDto) {
    return this.orders.assign(scope, id, body.userId ?? null, body.note);
  }

  @Post(':id/start')
  @Requires('action.work')
  @ApiOperation({ summary: 'Begin work' })
  start(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: NoteDto) {
    return this.orders.act(scope, id, 'start', body.note);
  }

  @Post(':id/complete')
  @Requires('action.work')
  @ApiOperation({ summary: 'Close the job with what was done' })
  complete(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: NoteDto) {
    return this.orders.act(scope, id, 'complete', body.note);
  }

  @Post(':id/cancel')
  @Requires('action.assign')
  @ApiOperation({ summary: 'Call the job off' })
  cancel(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: NoteDto) {
    return this.orders.act(scope, id, 'cancel', body.note);
  }

  @Post(':id/reopen')
  @Requires('action.assign')
  @ApiOperation({ summary: 'Neither ending is final' })
  reopen(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: NoteDto) {
    return this.orders.act(scope, id, 'reopen', body.note);
  }
}
