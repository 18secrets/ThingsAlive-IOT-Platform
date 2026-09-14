import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { Sample } from '../../prediction/services/influence';
import { withTenantSession } from '../../scope/tenant-session';
import { TelemetryReading } from '../../telemetry/telemetry-reading.entity';
import { CausalChainDefinition } from '../entities/causal-chain.entity';
import {
  CausalChain, ChainDiagnosis, ChainNode, ChainProjection,
  diagnoseChain, projectChain, topologicalOrder,
} from './causal-chain';

/** How far back to read telemetry when diagnosing. One shift plus the longest lag. */
export const DIAGNOSIS_WINDOW_HOURS = 12;

/** A cap, so one busy machine cannot pull a day of readings into memory. */
export const SAMPLE_CAP = 20_000;

export interface AssetRef {
  sourceSystem: string;
  externalId: string;
}

export interface ChainDraft {
  equipmentClassSlug: string;
  scenarioSlug?: string | null;
  name: string;
  description?: string | null;
  outcome?: string | null;
  nodes: ChainNode[];
  alignmentSeconds?: number | null;
  provenance?: string | null;
}

export interface AssetDiagnosis {
  sourceSystem: string;
  externalId: string;
  equipmentClassSlug: string | null;
  chains: ChainDiagnosis[];
  /** Chains bound to this machine's class that could not be run, and why. */
  skipped: { slug: string; reason: string }[];
}

/**
 * Authoring chains, and running them against a machine (task P4-01).
 *
 * Two jobs that look like one. Authoring is Things Alive writing down how a kind of
 * machine behaves; running is a client asking what their machine is doing about it.
 * They share a table and nothing else — one is platform-owned catalog content, the
 * other is a tenant-scoped read of telemetry — and the boundary between them is the
 * same one that keeps a client out of the scenario catalog.
 */
@Injectable()
export class ChainService {
  private readonly logger = new Logger(ChainService.name);

  constructor(private readonly ds: DataSource) {}

  /**
   * Write a chain down as a draft.
   *
   * Validated before it is stored rather than when it is run. A chain with a cycle in
   * it evaluates to nothing at all, and finding that out at three in the morning on a
   * customer's machine is the wrong moment — the author is the person who can fix it,
   * and they are here now.
   */
  async createDraft(scope: RequestScope, slug: string, draft: ChainDraft): Promise<CausalChainDefinition> {
    const problem = validateChain(draft.nodes);
    if (problem) throw new BadRequestException(problem);

    return this.ds.transaction(async (m) => {
      const repo = m.getRepository(CausalChainDefinition);
      const latest = await repo.findOne({ where: { slug }, order: { version: 'DESC' } });
      // A published version is immutable, so a new draft is the next version rather
      // than an edit. A draft, nobody has built anything on yet, and is replaced.
      if (latest?.status === 'draft') {
        await repo.update({ id: latest.id }, {
          ...draftColumns(draft), createdBy: scope.userId ?? null,
        });
        return repo.findOneByOrFail({ id: latest.id });
      }
      return repo.save(repo.create({
        slug,
        version: (latest?.version ?? 0) + 1,
        ...draftColumns(draft),
        status: 'draft',
        publishedAt: null,
        createdBy: scope.userId ?? null,
      }));
    });
  }

  /** Stand behind the numbers. After this the version cannot be edited. */
  async publish(scope: RequestScope, slug: string): Promise<CausalChainDefinition> {
    return this.ds.transaction(async (m) => {
      const repo = m.getRepository(CausalChainDefinition);
      const draft = await repo.findOne({ where: { slug, status: 'draft' }, order: { version: 'DESC' } });
      if (!draft) throw new NotFoundException(`No draft chain "${slug}" to publish.`);
      await repo.update({ id: draft.id }, { status: 'published', publishedAt: new Date() });
      return repo.findOneByOrFail({ id: draft.id });
    });
  }

  /** The published chains for an equipment class, newest version of each slug. */
  async publishedFor(equipmentClassSlug: string): Promise<CausalChainDefinition[]> {
    const rows = await this.ds.getRepository(CausalChainDefinition).find({
      where: { equipmentClassSlug, status: 'published' },
      order: { slug: 'ASC', version: 'DESC' },
    });
    const newest = new Map<string, CausalChainDefinition>();
    for (const row of rows) if (!newest.has(row.slug)) newest.set(row.slug, row);
    return [...newest.values()];
  }

  /**
   * What every chain bound to this machine's class says about it right now.
   *
   * A machine with no class gets no chains and is told so, rather than being run
   * against somebody else's physics — a compressor scored on a generator's thermal
   * curve produces confident nonsense, and the class binding is the only thing
   * standing between those two.
   */
  async diagnose(
    scope: RequestScope, ref: AssetRef, now = new Date(),
  ): Promise<AssetDiagnosis> {
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(ref.externalId)) {
      throw new NotFoundException(`No machine ${ref.externalId} here.`);
    }

    const asset = await withTenantSession(this.ds, scope, (m) =>
      m.getRepository(EquipmentProfile).findOne({
        where: { tenantId: scope.tenantId, ...ref },
      }));
    if (!asset) throw new NotFoundException(`No machine ${ref.externalId} here.`);

    const base = {
      sourceSystem: ref.sourceSystem,
      externalId: ref.externalId,
      equipmentClassSlug: asset.equipmentClassSlug,
    };
    if (!asset.equipmentClassSlug) {
      return {
        ...base, chains: [],
        skipped: [{
          slug: '*',
          reason: 'This machine has no equipment class, so no chain describes it. '
            + 'Bind it to a class to get a physical diagnosis.',
        }],
      };
    }

    const definitions = await this.publishedFor(asset.equipmentClassSlug);
    if (!definitions.length) {
      return {
        ...base, chains: [],
        skipped: [{
          slug: '*',
          reason: `No published chain for class "${asset.equipmentClassSlug}" yet.`,
        }],
      };
    }

    const samples = await this.samplesFor(scope, ref, now);
    const chains: ChainDiagnosis[] = [];
    const skipped: { slug: string; reason: string }[] = [];

    for (const definition of definitions) {
      const diagnosis = diagnoseChain(toChain(definition), samples);
      if (!diagnosis.evaluated && diagnosis.reason === 'cycle') {
        // Refused at authoring time, so this is a row that predates the check or was
        // written straight to the database. Loud rather than silently absent.
        this.logger.error(`Published chain ${definition.slug} has a cycle and cannot run.`);
        skipped.push({ slug: definition.slug, reason: 'The chain has a cycle in it.' });
        continue;
      }
      chains.push(diagnosis);
    }

    // Something actually wrong first, then the chains that could not be evaluated,
    // then the quiet ones. The order a screen reads in.
    chains.sort((a, b) => rank(a) - rank(b));
    return { ...base, chains, skipped };
  }

  /**
   * Where a chain ends up if its inputs go where the caller says.
   *
   * The inputs are supplied rather than extrapolated, deliberately. A chain that
   * guessed where the load was heading would bury an assumption about somebody's
   * afternoon inside a statement about physics.
   */
  async project(
    scope: RequestScope, slug: string, inputs: Record<string, number>,
  ): Promise<ChainProjection> {
    const definition = await this.ds.getRepository(CausalChainDefinition).findOne({
      where: { slug, status: 'published' }, order: { version: 'DESC' },
    });
    if (!definition) throw new NotFoundException(`No published chain "${slug}".`);
    return projectChain(toChain(definition), inputs);
  }

  /**
   * The readings a chain needs, in the shape it wants them.
   *
   * Pulled for the whole window rather than the newest value per signal, because the
   * lags mean a stage is scored against where its driver was some minutes ago — the
   * newest reading of the driver is the wrong one to use, and it is the one that a
   * naive "latest per signal" query would return.
   */
  private async samplesFor(
    scope: RequestScope, ref: AssetRef, now: Date,
  ): Promise<Sample[]> {
    const since = new Date(now.getTime() - DIAGNOSIS_WINDOW_HOURS * 3600_000);
    return withTenantSession(this.ds, scope, async (m) => {
      const rows = await m.query(
        // Machine to device to reading. `sensor_map_projection.external_id` is the
        // upstream *measurement* id, not the machine's — joining on it as though it
        // were the equipment code matches nothing in real data and everything in a
        // fixture that made the same mistake. The device projection is what knows
        // which loggers are fitted to which machine.
        `SELECT r."signal", r."value", r."source_timestamp"
           FROM "telemetry_reading" r
           JOIN "device_projection" d
             ON d."imei" = r."imei" AND d."tenant_id" = r."tenant_id"
          WHERE r."tenant_id" = $1 AND d."source_system" = $2
            AND d."equipment_external_id" = $3
            AND r."source_timestamp" >= $4
          ORDER BY r."source_timestamp" DESC
          LIMIT ${SAMPLE_CAP}`,
        [scope.tenantId, ref.sourceSystem, ref.externalId, since],
      );
      return rows.map((r: Record<string, unknown>) => ({
        signal: String(r.signal),
        value: Number(r.value),
        at: new Date(r.source_timestamp as string).getTime(),
      })).filter((s: Sample) => Number.isFinite(s.value));
    });
  }
}

/** Worst first: a fault, then a chain nothing could be said about, then the quiet ones. */
function rank(d: ChainDiagnosis): number {
  if (d.origin?.severity === 'critical') return 0;
  if (d.origin) return 1;
  if (!d.evaluated) return 2;
  return 3;
}

function toChain(definition: CausalChainDefinition): CausalChain {
  return {
    slug: definition.slug,
    outcome: definition.outcome ?? undefined,
    nodes: definition.nodes,
    alignmentSeconds: definition.alignmentSeconds ?? undefined,
  };
}

function draftColumns(draft: ChainDraft) {
  return {
    equipmentClassSlug: draft.equipmentClassSlug,
    scenarioSlug: draft.scenarioSlug ?? null,
    name: draft.name,
    description: draft.description ?? null,
    outcome: draft.outcome ?? null,
    nodes: draft.nodes,
    alignmentSeconds: draft.alignmentSeconds ?? null,
    provenance: draft.provenance ?? null,
  };
}

/**
 * Everything about a chain that can be decided without telemetry.
 *
 * Caught here rather than at run time on purpose. Each of these produces a chain that
 * evaluates to "nothing is wrong" on every machine it is bound to, which is the most
 * expensive way for a definition to be broken: it looks configured, it never fires, and
 * nobody finds out until the failure it was meant to catch has happened.
 */
export function validateChain(nodes: ChainNode[]): string | null {
  if (!nodes.length) return 'A chain needs at least one stage.';

  const seen = new Set<string>();
  for (const node of nodes) {
    if (!node.signal) return 'Every stage needs the signal it predicts.';
    if (seen.has(node.signal)) {
      return `Two stages both predict ${node.signal}. A signal has one explanation.`;
    }
    seen.add(node.signal);

    if (!(node.warnAbove > 0)) {
      return `Stage ${node.signal} needs a positive warnAbove; without one nothing can exceed it.`;
    }
    if (node.criticalAbove < node.warnAbove) {
      return `Stage ${node.signal} has criticalAbove below warnAbove, so it would never`
        + ' reach critical.';
    }
    if (!node.drivers.length) {
      return `Stage ${node.signal} has no drivers, so its expectation is a constant and`
        + ' the chain is a threshold wearing a costume.';
    }
    for (const driver of node.drivers) {
      if (driver.signal === node.signal) {
        return `Stage ${node.signal} drives itself.`;
      }
      if (!Number.isFinite(driver.coefficient)) {
        return `Driver ${driver.signal} of ${node.signal} has no usable coefficient.`;
      }
      if ((driver.lagSeconds ?? 0) < 0) {
        return `Driver ${driver.signal} of ${node.signal} has a negative lag, which would`
          + ' read the effect before the cause.';
      }
    }
  }

  if (!topologicalOrder(nodes)) {
    return 'The chain has a cycle in it. A feedback loop is physically real and is not a'
      + ' predictive chain; break it at the link you are willing to treat as an input.';
  }
  return null;
}
