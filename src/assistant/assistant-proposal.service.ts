import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Capability, can } from '../auth/capabilities';
import { RequestScope } from '../auth/types/request-scope';
import { CLIENT_SOURCE_SYSTEM, ServiceTier } from '../equipment/equipment-profile.entity';

const SERVICE_TIERS: ServiceTier[] = ['basic', 'standard', 'advanced', 'full'];
import { CODE_PATTERN as EQUIPMENT_CODE, EquipmentService } from '../equipment/services/equipment.service';
import { PlantService } from '../equipment/services/plant.service';
import { InventoryService } from '../inventory/services/inventory.service';
import { withTenantSession } from '../scope/tenant-session';
import { AssistantProposal, ProposalKind, ProposalStatus } from './assistant-proposal.entity';

/** Long enough to come back after lunch; short enough that a forgotten one does not apply next month. */
export const PROPOSAL_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** The capability the confirming person needs: the one the matching screen's route requires. */
export const PROPOSAL_CAPABILITY: Record<ProposalKind, Capability> = {
  create_site: 'equipment.write',
  create_equipment: 'equipment.write',
  fit_logger: 'device.claim',
};

const SITE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/**
 * Proposals from the onboarding assistant, and the decision on each (task QCHAT2, G09).
 *
 * The model's tool call is input, so a proposal is checked for shape and turned into
 * a fixed sentence here — the person approves our words about the payload, not the
 * model's description of it. Whether the thing can actually be done is left to the
 * service that does it, at confirm time, as that person: a site that appeared in the
 * meantime, a logger fitted by hand, a capability taken away an hour ago are all
 * answered there, by the same checks a click on the screen meets.
 *
 * Confirm is idempotent. A per-proposal advisory lock, held on its own connection
 * across the service call, makes a second confirm wait and then return the first
 * one's outcome rather than run the service again; the trigger makes a decided
 * proposal final in the database, so no code path can decide it twice. The lock is a
 * session lock because the services open their own transactions, which a
 * transaction-scoped lock could not span.
 */
@Injectable()
export class AssistantProposalService {
  constructor(
    private readonly ds: DataSource,
    private readonly equipment: EquipmentService,
    private readonly plants: PlantService,
    private readonly inventory: InventoryService,
  ) {}

  async propose(
    scope: RequestScope, kind: ProposalKind, args: Record<string, unknown>, now = new Date(),
  ): Promise<AssistantProposal> {
    if (!can(scope, PROPOSAL_CAPABILITY[kind])) {
      throw new ForbiddenException(`This role cannot ${kind.replace('_', ' ')}.`);
    }
    const { payload, summary } = shape(kind, args);
    return withTenantSession(this.ds, scope, (m) => {
      const repo = m.getRepository(AssistantProposal);
      return repo.save(repo.create({
        tenantId: scope.tenantId, kind, payload, summary, status: 'proposed', proposedBy: scope.userId,
        proposedAt: now, expiresAt: new Date(now.getTime() + PROPOSAL_LIFETIME_MS),
      }));
    });
  }

  async list(scope: RequestScope, status?: ProposalStatus): Promise<AssistantProposal[]> {
    return withTenantSession(this.ds, scope, (m) => m.getRepository(AssistantProposal).find({
      where: { tenantId: scope.tenantId, ...(status ? { status } : {}) },
      order: { proposedAt: 'DESC' },
      take: 50,
    }));
  }

  /** Does what was proposed, as the confirming person. Returns the proposal as decided. */
  async confirm(scope: RequestScope, id: string, now = new Date()): Promise<AssistantProposal> {
    return this.decide(scope, id, async (p) => {
      if (!can(scope, PROPOSAL_CAPABILITY[p.kind])) {
        throw new ForbiddenException(`This role cannot ${p.kind.replace('_', ' ')}; ask someone who can to confirm it.`);
      }
      if (p.expiresAt <= now) return { status: 'expired', result: null, error: 'Expired before anyone confirmed it.' };
      try {
        return { status: 'applied', result: await this.apply(scope, p), error: null };
      } catch (err) {
        // A refusal from the service is the outcome, recorded and final: asking again
        // would get the same answer. Anything else (the database went away) is not an
        // outcome, and leaves the proposal open to confirm again.
        if (err instanceof HttpException && err.getStatus() < 500) {
          return { status: 'failed', result: null, error: err.message };
        }
        throw err;
      }
    }, now);
  }

  async reject(scope: RequestScope, id: string, now = new Date()): Promise<AssistantProposal> {
    return this.decide(scope, id, async () => ({ status: 'rejected', result: null, error: null }), now);
  }

  private async decide(
    scope: RequestScope, id: string,
    outcome: (p: AssistantProposal) => Promise<{ status: ProposalStatus; result: Record<string, unknown> | null; error: string | null }>,
    now: Date,
  ): Promise<AssistantProposal> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('No such proposal in this account.');
    const lock = this.ds.createQueryRunner();
    await lock.connect();
    try {
      await lock.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`assistant-proposal:${id}`]);
      const read = () => withTenantSession(this.ds, scope, (m) =>
        m.getRepository(AssistantProposal).findOne({ where: { id, tenantId: scope.tenantId } }));
      const p = await read();
      if (!p) throw new NotFoundException('No such proposal in this account.');
      if (p.status !== 'proposed') return p;

      const o = await outcome(p);
      await withTenantSession(this.ds, scope, (m) => m.getRepository(AssistantProposal).update(
        { id, status: 'proposed' },
        { status: o.status, result: o.result, error: o.error, decidedBy: scope.userId, decidedAt: now },
      ));
      return (await read())!;
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`assistant-proposal:${id}`]).catch(() => undefined);
      await lock.release();
    }
  }

  private async apply(scope: RequestScope, p: AssistantProposal): Promise<Record<string, unknown>> {
    const v = p.payload as Record<string, string | null>;
    const n = p.payload as Record<string, number | null>;
    switch (p.kind) {
      case 'create_site': {
        const site = await this.plants.create(scope, { code: v.code!, name: v.name! });
        return { siteId: site.id, code: site.code };
      }
      case 'create_equipment': {
        let plantId: string | null = null;
        if (v.siteCode) {
          const site = (await this.plants.list(scope)).find((s) => s.code.toLowerCase() === v.siteCode!.toLowerCase());
          if (!site) throw new NotFoundException(`No site "${v.siteCode}" in this account.`);
          plantId = site.id;
        }
        const machine = await this.equipment.create(scope, {
          code: v.code!, name: v.name!, plantId, manufacturer: v.manufacturer ?? null,
          modelNumber: v.modelNumber ?? null, equipmentClassSlug: v.classSlug ?? null,
          serialNumber: v.serialNumber ?? null, description: v.description ?? null,
          ...(v.tier ? { tier: v.tier as ServiceTier } : {}),
          commissionedAt: v.commissionedAt ? new Date(`${v.commissionedAt}T00:00:00Z`) : null,
          serviceIntervalHours: n.serviceIntervalHours ?? null,
        });
        return { sourceSystem: machine.sourceSystem, code: machine.externalId };
      }
      case 'fit_logger': {
        const device = await this.inventory.claim(scope, v.imei!, v.equipmentCode!, v.sourceSystem!);
        return { imei: device.imei, equipmentCode: device.equipmentExternalId };
      }
    }
  }
}

/** The model's arguments, checked and reduced to the payload, with the sentence a person approves. */
function shape(kind: ProposalKind, args: Record<string, unknown>): { payload: Record<string, unknown>; summary: string } {
  const text = (k: string, max = 120): string | null => {
    const v = args[k];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || v.trim().length > max) throw new BadRequestException(`${k} must be text of at most ${max} characters.`);
    return v.trim();
  };
  const need = (k: string, max?: number): string => {
    const v = text(k, max);
    if (!v) throw new BadRequestException(`${k} is required.`);
    return v;
  };

  switch (kind) {
    case 'create_site': {
      const code = need('code', 40);
      if (!SITE_CODE.test(code)) throw new BadRequestException(`Site code "${code}" is not valid: letters, digits, dots, hyphens or underscores.`);
      const name = need('name');
      return { payload: { code, name }, summary: `Add the site "${name}" (code ${code}).` };
    }
    case 'create_equipment': {
      const code = need('code', 64);
      if (!EQUIPMENT_CODE.test(code)) throw new BadRequestException(`Machine code "${code}" is not valid: letters, digits, dots, hyphens or underscores.`);
      const name = need('name');
      const siteCode = text('siteCode', 40);
      const tier = text('tier', 16);
      if (tier && !SERVICE_TIERS.includes(tier as ServiceTier)) {
        throw new BadRequestException(`tier must be one of ${SERVICE_TIERS.join(', ')}.`);
      }
      const commissionedAt = text('commissionedAt', 10);
      if (commissionedAt && (!/^\d{4}-\d{2}-\d{2}$/.test(commissionedAt) || Number.isNaN(Date.parse(commissionedAt)))) {
        throw new BadRequestException(`commissionedAt must be a date written YYYY-MM-DD.`);
      }
      const interval = args.serviceIntervalHours;
      if (interval !== undefined && interval !== null && interval !== ''
        && !(Number.isInteger(Number(interval)) && Number(interval) > 0)) {
        throw new BadRequestException('serviceIntervalHours must be a whole number of hours above 0.');
      }
      const payload = {
        code, name, siteCode, manufacturer: text('manufacturer'), modelNumber: text('modelNumber'), classSlug: text('classSlug'),
        serialNumber: text('serialNumber'), description: text('description', 500), tier, commissionedAt,
        serviceIntervalHours: interval === undefined || interval === null || interval === '' ? null : Number(interval),
      };
      // The person approves this sentence, so every field that will be written is in it.
      const details = [
        payload.classSlug && `type ${payload.classSlug}`,
        [payload.manufacturer, payload.modelNumber].filter(Boolean).join(' '),
        payload.serialNumber && `serial ${payload.serialNumber}`,
        tier && `${tier} tier`,
        commissionedAt && `commissioned ${commissionedAt}`,
        payload.serviceIntervalHours && `service every ${payload.serviceIntervalHours} h`,
      ].filter(Boolean).join(', ');
      return {
        payload,
        summary: `Add the machine "${name}" (code ${code})${details ? `, ${details}` : ''}${siteCode ? ` at site ${siteCode}` : ', with no site yet'}.`,
      };
    }
    case 'fit_logger': {
      const imei = need('imei', 32);
      const equipmentCode = need('equipmentCode', 64);
      const sourceSystem = text('sourceSystem', 64) ?? CLIENT_SOURCE_SYSTEM;
      return { payload: { imei, equipmentCode, sourceSystem }, summary: `Fit logger ${imei} to machine ${equipmentCode}.` };
    }
  }
}
