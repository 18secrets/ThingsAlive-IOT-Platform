import {
  BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { can } from '../../auth/capabilities';
import { SCOPE_RESOLVER, ScopeResolver } from '../../auth/scope-resolver';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { withTenantSession } from '../../scope/tenant-session';
import { WorkOrderEvent, WorkOrderEventKind } from '../entities/work-order-event.entity';
import { WorkOrder, WorkOrderCounter, WorkOrderPriority } from '../entities/work-order.entity';
import { WorkOrderAction, workOrderTransition } from './work-order-state-machine';

export interface EquipmentRef {
  sourceSystem: string;
  externalId: string;
}

export interface RaiseInput extends EquipmentRef {
  title: string;
  description?: string | null;
  priority?: WorkOrderPriority;
  assignedToUserId?: string | null;
  predictionId?: string | null;
  dueAt?: Date | null;
}

export interface ListFilter {
  status?: string[];
  assignedToUserId?: string;
  externalId?: string;
  mine?: boolean;
}

/**
 * Jobs on machines (task P1-87).
 *
 * Two rules carry most of this, and they are the ones worth disagreeing with:
 *
 * Visibility follows the machine, not the assignment. If a machine is in your scope
 * you see every job on it, including jobs assigned to somebody else. The alternative —
 * each operator seeing only their own — hides the fact that two people were sent to
 * the same generator, which is the failure this is meant to prevent rather than cause.
 *
 * Acting follows the assignment. Starting and completing are for the person holding
 * the job; anybody who can assign can also act, because somebody has to be able to
 * close a job for a fitter who has gone home.
 */
@Injectable()
export class WorkOrderService {
  constructor(
    private readonly ds: DataSource,
    @Optional() @Inject(SCOPE_RESOLVER) private readonly resolver?: ScopeResolver,
  ) {}

  async raise(scope: RequestScope, input: RaiseInput, now = new Date()): Promise<WorkOrder> {
    this.assertCanAssign(scope, 'raise a job');
    if (!input.title?.trim()) throw new BadRequestException('A job needs a title.');

    return withTenantSession(this.ds, scope, async (m) => {
      await this.assertAssetVisible(m, scope, input);
      if (input.assignedToUserId) {
        await this.assertAssignable(scope, input.assignedToUserId, input);
      }

      const repo = m.getRepository(WorkOrder);
      const order = await repo.save(repo.create({
        tenantId: scope.tenantId,
        reference: await this.nextReference(m, scope.tenantId),
        sourceSystem: input.sourceSystem,
        externalId: input.externalId,
        title: input.title.trim(),
        description: input.description ?? null,
        status: 'created',
        priority: input.priority ?? 'normal',
        assignedToUserId: input.assignedToUserId ?? null,
        predictionId: input.predictionId ?? null,
        dueAt: input.dueAt ?? null,
        startedAt: null,
        endedAt: null,
        resolution: null,
        raisedBy: scope.userId,
      }));

      await this.record(m, scope, order.id, 'raised', {
        toStatus: 'created', toAssignee: order.assignedToUserId, note: order.title,
      });
      if (order.assignedToUserId) {
        await this.record(m, scope, order.id, 'assigned', { toAssignee: order.assignedToUserId });
      }
      return order;
    });
  }

  /**
   * Hand the job to somebody, or take it back off them.
   *
   * Refused when the machine is not in that person's scope, rather than assigning it
   * and letting them discover they cannot open it. The two ways of being wrong are not
   * symmetrical: a refusal names the missing assignment and can be fixed in a minute,
   * while a job nobody can see sits there looking like work in hand.
   */
  async assign(
    scope: RequestScope, id: string, userId: string | null, note?: string | null,
  ): Promise<WorkOrder> {
    this.assertCanAssign(scope, 'assign a job');
    return withTenantSession(this.ds, scope, async (m) => {
      const order = await this.load(m, scope, id);
      if (order.status === 'completed' || order.status === 'cancelled') {
        throw new BadRequestException(`This job is ${order.status}. Reopen it before reassigning.`);
      }
      if (userId) await this.assertAssignable(scope, userId, order);

      const from = order.assignedToUserId;
      order.assignedToUserId = userId;
      const saved = await m.getRepository(WorkOrder).save(order);
      await this.record(m, scope, id, userId ? 'assigned' : 'unassigned', {
        fromAssignee: from, toAssignee: userId, note: note ?? null,
      });
      return saved;
    });
  }

  async act(
    scope: RequestScope, id: string, action: WorkOrderAction,
    note: string | null | undefined, now = new Date(),
  ): Promise<WorkOrder> {
    return withTenantSession(this.ds, scope, async (m) => {
      const order = await this.load(m, scope, id);
      this.assertMayAct(scope, order, action);

      const { to } = workOrderTransition(action, order.status, note);
      const from = order.status;
      order.status = to;

      if (action === 'start') order.startedAt = now;
      if (action === 'complete') {
        order.endedAt = now;
        order.resolution = note!.trim();
      }
      if (action === 'cancel') order.endedAt = now;
      if (action === 'reopen') {
        // Cleared, not kept. A reopened job that still carries the old completion
        // timestamp reads, on any screen and in any export, as finished.
        order.endedAt = null;
        order.resolution = null;
      }

      const saved = await m.getRepository(WorkOrder).save(order);
      const kind: WorkOrderEventKind =
        action === 'start' ? 'started'
          : action === 'complete' ? 'completed'
            : action === 'cancel' ? 'cancelled' : 'reopened';
      await this.record(m, scope, id, kind, {
        fromStatus: from, toStatus: to, note: note ?? null,
      });
      return saved;
    });
  }

  async list(scope: RequestScope, filter: ListFilter = {}): Promise<WorkOrder[]> {
    return withTenantSession(this.ds, scope, async (m) => {
      const where: Record<string, unknown> = { tenantId: scope.tenantId };
      if (filter.status?.length) where.status = In(filter.status);
      if (filter.mine) where.assignedToUserId = scope.userId;
      else if (filter.assignedToUserId) where.assignedToUserId = filter.assignedToUserId;
      if (filter.externalId) where.externalId = filter.externalId;

      // An empty list is entitled to nothing; undefined is unrestricted. Reading the
      // empty case as "no filter" is how somebody assigned to no machines is handed
      // every job in the account.
      if (scope.equipmentIds !== undefined) {
        if (scope.equipmentIds.length === 0) return [];
        where.externalId = filter.externalId
          ? (scope.equipmentIds.includes(filter.externalId) ? filter.externalId : undefined)
          : In([...scope.equipmentIds]);
        if (where.externalId === undefined) return [];
      }

      return m.getRepository(WorkOrder).find({
        where: where as any,
        order: { createdAt: 'DESC' },
      });
    });
  }

  async history(scope: RequestScope, id: string): Promise<WorkOrderEvent[]> {
    return withTenantSession(this.ds, scope, async (m) => {
      await this.load(m, scope, id);
      return m.getRepository(WorkOrderEvent).find({
        where: { tenantId: scope.tenantId, workOrderId: id },
        order: { at: 'ASC' },
      });
    });
  }

  /** Descriptive edits only. Status and assignment have their own methods. */
  async update(
    scope: RequestScope, id: string,
    input: { title?: string; description?: string | null; priority?: WorkOrderPriority; dueAt?: Date | null },
  ): Promise<WorkOrder> {
    this.assertCanAssign(scope, 'edit a job');
    return withTenantSession(this.ds, scope, async (m) => {
      const order = await this.load(m, scope, id);
      if (input.title !== undefined) {
        if (!input.title.trim()) throw new BadRequestException('A job needs a title.');
        order.title = input.title.trim();
      }
      if (input.description !== undefined) order.description = input.description;
      if (input.priority !== undefined) order.priority = input.priority;
      if (input.dueAt !== undefined) order.dueAt = input.dueAt;

      const saved = await m.getRepository(WorkOrder).save(order);
      await this.record(m, scope, id, 'edited', {});
      return saved;
    });
  }

  private assertCanAssign(scope: RequestScope, what: string): void {
    if (!can(scope, 'action.assign')) {
      throw new ForbiddenException(`You cannot ${what}. That is for a manager.`);
    }
  }

  /**
   * Who may move this job.
   *
   * An operator holds `action.work` and may start and complete what is theirs.
   * Cancelling and reopening are a manager's, because they overrule somebody's
   * decision rather than carrying it out.
   */
  private assertMayAct(scope: RequestScope, order: WorkOrder, action: WorkOrderAction): void {
    if (action === 'cancel' || action === 'reopen') {
      this.assertCanAssign(scope, `${action} a job`);
      return;
    }
    if (!can(scope, 'action.work')) {
      throw new ForbiddenException('You cannot work on jobs.');
    }
    const mine = order.assignedToUserId === scope.userId;
    if (!mine && !can(scope, 'action.assign')) {
      throw new ForbiddenException(
        `${order.reference} is assigned to somebody else. Ask a manager to reassign it.`,
      );
    }
  }

  /** The machine has to be one this account holds, and one the caller can see. */
  private async assertAssetVisible(
    m: EntityManager, scope: RequestScope, ref: EquipmentRef,
  ): Promise<void> {
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(ref.externalId)) {
      throw new NotFoundException('No such machine in this account.');
    }
    const asset = await m.getRepository(EquipmentProfile).findOne({
      where: { tenantId: scope.tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId },
    });
    if (!asset) throw new NotFoundException('No such machine in this account.');
    if (asset.status === 'retired') {
      throw new BadRequestException('That machine is retired. Jobs cannot be raised against it.');
    }
  }

  /**
   * Can this person even see the machine?
   *
   * Asked of the scope resolver rather than answered here. "What can this person see"
   * has one implementation, and a second one written for assignment would drift from
   * it the first time a role shape changed — silently, and in the direction of
   * assigning work nobody can open.
   */
  private async assertAssignable(
    scope: RequestScope, userId: string, ref: EquipmentRef,
  ): Promise<void> {
    if (!this.resolver) return;
    const them = await this.resolver.resolve(scope.tenantId, userId).catch(() => null);
    if (!them) throw new NotFoundException('No such person in this account.');
    if (them.equipmentIds !== undefined && !them.equipmentIds.includes(ref.externalId)) {
      throw new BadRequestException(
        'That person is not assigned to this machine, so they would not be able to open '
        + 'the job. Assign them the machine first.',
      );
    }
  }

  private async load(m: EntityManager, scope: RequestScope, id: string): Promise<WorkOrder> {
    const order = await m.getRepository(WorkOrder).findOne({
      where: { tenantId: scope.tenantId, id },
    });
    if (!order) throw new NotFoundException('No such job in this account.');
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(order.externalId)) {
      throw new NotFoundException('No such job in this account.');
    }
    return order;
  }

  private async record(
    m: EntityManager, scope: RequestScope, workOrderId: string, kind: WorkOrderEventKind,
    fields: Partial<Pick<WorkOrderEvent, 'fromStatus' | 'toStatus' | 'fromAssignee' | 'toAssignee' | 'note'>>,
  ): Promise<void> {
    const repo = m.getRepository(WorkOrderEvent);
    await repo.save(repo.create({
      tenantId: scope.tenantId, workOrderId, kind,
      fromStatus: fields.fromStatus ?? null,
      toStatus: fields.toStatus ?? null,
      fromAssignee: fields.fromAssignee ?? null,
      toAssignee: fields.toAssignee ?? null,
      note: fields.note ?? null,
      actorUserId: scope.userId,
    }));
  }

  /**
   * The account's next number, taken under a row lock.
   *
   * One statement so two people raising a job at the same moment cannot both read 41.
   * The lock is per account, which is the narrowest thing it could be and still be
   * correct.
   */
  private async nextReference(m: EntityManager, tenantId: string): Promise<string> {
    const [row] = await m.query(
      `INSERT INTO "work_order_counter" ("tenant_id", "next_number") VALUES ($1, 2)
       ON CONFLICT ("tenant_id") DO UPDATE SET "next_number" = "work_order_counter"."next_number" + 1
       RETURNING "next_number"`,
      [tenantId],
    );
    const n = Number(row.next_number) - 1;
    return `WO-${String(n).padStart(6, '0')}`;
  }
}
