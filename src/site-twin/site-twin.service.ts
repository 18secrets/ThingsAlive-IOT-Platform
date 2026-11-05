import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull, QueryFailedError } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { Plant } from '../equipment/entities/plant.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { withTenantSession } from '../scope/tenant-session';
import { ClientEquipmentClass } from '../client-catalog/entities/client-equipment-class.entity';
import { BreakdownEvent } from '../utilization/entities/breakdown-event.entity';
import { composeAround, composeLayout, Draft } from './compose';
import { EQUIPMENT_BACKED, PROGRESS_KINDS, SiteTwin, SiteTwinPlacement, SiteTwinZone, ZoneKind } from './site-twin.entity';

/** What a site that has never been laid out is drawn as. A yard, not a guess at the
 * real site: `saved: false` says so. */
export const DEFAULT_EXTENT = { widthM: 200, depthM: 120 } as const;

export interface ZoneInput {
  key: string; label: string; kind: ZoneKind; x: number; z: number; widthM: number; depthM: number;
  floors?: number | null;
  /** What the site reports as done. The date it was reported is the server's, not the client's. */
  progressPct?: number | null;
}
export interface PlacementInput {
  sourceSystem: string; externalId: string; x: number; z: number; headingDeg: number;
  route?: string[];
}
export interface LayoutInput {
  expectedVersion: number;
  extent: { widthM: number; depthM: number };
  zones: ZoneInput[];
  placements: PlacementInput[];
}

export interface ZoneView {
  id: string; key: string; label: string; kind: ZoneKind; x: number; z: number; widthM: number; depthM: number;
  floors: number | null; progressPct: number | null; progressReportedAt: string | null; progressReportedBy: string | null;
}

export interface SiteLayout {
  plant: Plant;
  /** Machines at this site the caller can see — the twin draws these and no others. */
  machines: EquipmentProfile[];
  saved: boolean;
  version: number;
  /** Who saved the layout last; null when never saved. */
  updatedBy: string | null;
  extent: { widthM: number; depthM: number };
  zones: ZoneView[];
  placements: Map<string, { x: number; z: number; headingDeg: number; route: string[] }>;
  /** Each machine's class category, by machine key — what equipment-backed kinds read. */
  categories: Map<string, string | null>;
  /** Machines with a breakdown that has not ended. */
  brokenDown: Set<string>;
  /** Saved structures not drawn because no machine assigned here backs them any more. */
  hiddenZones: string[];
}

const key = (sourceSystem: string, externalId: string) => `${sourceSystem}/${externalId}`;

/**
 * A site's digital-twin layout: the extent, the zones and structures, and where each
 * machine stands.
 *
 * A save replaces the whole layout and names the version it was drawn on. Whole, because
 * the editor holds the whole picture and a per-machine PATCH would let two people's
 * drags interleave into a layout neither drew; versioned, because the loser of that race
 * should be told, not silently overwritten. The version check runs under the site row's
 * lock, so two saves on the same version cannot both pass it.
 *
 * Progress has its own write (`reportProgress`) because the person who reports how far
 * a building has got is not the person who lays out the site. It takes the same lock and
 * bumps the same version, so an editor holding the old picture cannot save over it.
 */
@Injectable()
export class SiteTwinService {
  constructor(private readonly ds: DataSource) {}

  read(scope: RequestScope, plantId: string): Promise<SiteLayout> {
    assertSiteInScope(scope, plantId);
    return withTenantSession(this.ds, scope, (m) => this.readIn(m, scope, plantId));
  }

  async save(scope: RequestScope, plantId: string, input: LayoutInput, at: Date = new Date()): Promise<SiteLayout> {
    assertSiteInScope(scope, plantId);
    return mapCheck(() => withTenantSession(this.ds, scope, async (m) => {
      const { machines } = await this.siteAndMachines(m, scope, plantId);
      const twin = await this.lockTwin(m, scope, plantId, true);
      assertVersion(twin, input.expectedVersion);

      const here = new Set(machines.map((e) => key(e.sourceSystem, e.externalId)));
      // No plant the site does not have: an equipment-backed structure needs a machine of
      // its kind assigned here. Checked against every machine at the site, not just the
      // ones this caller sees — whether a generator exists does not depend on who asks.
      const categories = await this.categoriesOf(m, scope, (await m.getRepository(EquipmentProfile)
        .find({ where: { tenantId: scope.tenantId, plantId } })));
      for (const z of input.zones) {
        const backed = EQUIPMENT_BACKED[z.kind];
        if (backed && !backs(backed.test, categories)) {
          throw new BadRequestException(`"${z.label}" is a ${z.kind.replace(/_/g, ' ')}, which needs ${backed.needs} assigned to this site; none is.`);
        }
      }
      const seen = new Set<string>();
      for (const p of input.placements) {
        const k = key(p.sourceSystem, p.externalId);
        if (!here.has(k)) throw new BadRequestException(`${k} is not a machine at this site.`);
        if (seen.has(k)) throw new BadRequestException(`${k} is placed twice.`);
        seen.add(k);
      }

      // Progress unchanged keeps the date it was first reported; a new figure is dated now.
      const before = new Map((await m.getRepository(SiteTwinZone).find({ where: { tenantId: scope.tenantId, plantId } }))
        .map((z) => [z.key, z]));

      // Only what the caller can see is replaced. A user scoped to some machines on a
      // shared site saves their part of the picture; the rest stays where it was.
      await m.getRepository(SiteTwinZone).delete({ tenantId: scope.tenantId, plantId });
      await m.getRepository(SiteTwinPlacement).delete({
        tenantId: scope.tenantId, plantId,
        ...(scope.equipmentIds === undefined ? {} : { externalId: In([...scope.equipmentIds]) }),
      });
      await m.getRepository(SiteTwin).update(
        { tenantId: scope.tenantId, plantId },
        { widthM: input.extent.widthM, depthM: input.extent.depthM, version: twin.version + 1, updatedBy: scope.userId, updatedAt: at },
      );
      if (input.zones.length) {
        await m.getRepository(SiteTwinZone).insert(input.zones.map((z, i) => {
          const pct = z.progressPct ?? null;
          const prev = before.get(z.key);
          const same = prev && prev.progressPct === pct;
          return {
            tenantId: scope.tenantId, plantId, key: z.key, label: z.label.trim(), kind: z.kind,
            x: z.x, z: z.z, widthM: z.widthM, depthM: z.depthM, floors: z.floors ?? null, sortOrder: i,
            progressPct: pct,
            progressReportedAt: pct === null ? null : same ? prev!.progressReportedAt : at,
            progressReportedBy: pct === null ? null : same ? prev!.progressReportedBy : scope.userId,
          };
        }));
      }
      if (input.placements.length) {
        await m.getRepository(SiteTwinPlacement).insert(input.placements.map((p) => ({
          tenantId: scope.tenantId, plantId, sourceSystem: p.sourceSystem, externalId: p.externalId,
          x: p.x, z: p.z, headingDeg: normaliseHeading(p.headingDeg), route: p.route ?? [],
        })));
      }
      return this.readIn(m, scope, plantId);
    }));
  }

  /** A first layout from the machines assigned to the site (`composeLayout`), not saved.
   * `attention` adds machines the caller knows need a person; open breakdowns are read
   * here. With a `draft`, the editor's zones are kept and the machines are arranged
   * around them (`composeAround`). */
  async propose(scope: RequestScope, plantId: string, attention: Set<string> = new Set(), draft?: Draft): Promise<LayoutInput> {
    const layout = await this.read(scope, plantId);
    const machines = layout.machines.map((e) => {
      const k = key(e.sourceSystem, e.externalId);
      return {
        sourceSystem: e.sourceSystem, externalId: e.externalId, classSlug: e.equipmentClassSlug,
        category: layout.categories.get(k) ?? null, attention: attention.has(k) || layout.brokenDown.has(k),
      };
    });
    return draft ? composeAround(machines, draft, layout.version) : composeLayout(machines, layout.version);
  }

  /** One structure's progress, as reported by the site. Not idempotent for the same
   * reason a save is not: it bumps the layout version. */
  async reportProgress(
    scope: RequestScope, plantId: string, zoneKey: string, progressPct: number, at: Date = new Date(),
  ): Promise<SiteLayout> {
    assertSiteInScope(scope, plantId);
    return mapCheck(() => withTenantSession(this.ds, scope, async (m) => {
      await this.siteAndMachines(m, scope, plantId);
      const twin = await this.lockTwin(m, scope, plantId, false);
      if (!twin) throw new NotFoundException('This site has no layout yet.');
      const zone = await m.getRepository(SiteTwinZone).findOne({ where: { tenantId: scope.tenantId, plantId, key: zoneKey } });
      if (!zone) throw new NotFoundException(`No zone "${zoneKey}" on this site.`);
      if (!PROGRESS_KINDS.includes(zone.kind)) {
        throw new BadRequestException(`A ${zone.kind} is not built in stages; only ${PROGRESS_KINDS.join(', ')} report progress.`);
      }
      await m.getRepository(SiteTwinZone).update(
        { id: zone.id }, { progressPct, progressReportedAt: at, progressReportedBy: scope.userId },
      );
      await m.getRepository(SiteTwin).update(
        { tenantId: scope.tenantId, plantId }, { version: twin.version + 1, updatedAt: at },
      );
      return this.readIn(m, scope, plantId);
    }));
  }

  /** The site's twin row under `pessimistic_write`, created first when `create` is set.
   * A concurrent first save waits on the other's uncommitted insert, then finds
   * version 1 and loses the version check. */
  private async lockTwin(m: EntityManager, scope: RequestScope, plantId: string, create: true): Promise<SiteTwin>;
  private async lockTwin(m: EntityManager, scope: RequestScope, plantId: string, create: false): Promise<SiteTwin | null>;
  private async lockTwin(m: EntityManager, scope: RequestScope, plantId: string, create: boolean): Promise<SiteTwin | null> {
    if (create) {
      await m.query(
        `INSERT INTO site_twin (tenant_id, plant_id, width_m, depth_m) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [scope.tenantId, plantId, DEFAULT_EXTENT.widthM, DEFAULT_EXTENT.depthM],
      );
    }
    return m.getRepository(SiteTwin).createQueryBuilder('t')
      .setLock('pessimistic_write')
      .where('t.tenant_id = :tenantId AND t.plant_id = :plantId', { tenantId: scope.tenantId, plantId })
      .getOne();
  }

  private async siteAndMachines(m: EntityManager, scope: RequestScope, plantId: string) {
    const plant = await m.getRepository(Plant).findOne({ where: { tenantId: scope.tenantId, id: plantId } });
    if (!plant) throw new NotFoundException('No such site in this account.');
    const all = await m.getRepository(EquipmentProfile).find({ where: { tenantId: scope.tenantId, plantId }, order: { externalId: 'ASC' } });
    const machines = scope.equipmentIds === undefined ? all : all.filter((e) => scope.equipmentIds!.includes(e.externalId));
    return { plant, machines };
  }

  private async categoriesOf(m: EntityManager, scope: RequestScope, machines: EquipmentProfile[]): Promise<Map<string, string | null>> {
    const slugs = [...new Set(machines.map((e) => e.equipmentClassSlug).filter((s): s is string => !!s))];
    const classes = slugs.length
      ? await m.getRepository(ClientEquipmentClass).find({ where: { tenantId: scope.tenantId, slug: In(slugs) } })
      : [];
    const bySlug = new Map(classes.map((c) => [c.slug, c.category]));
    // The slug rides along so a class with no category still says what it is.
    return new Map(machines.map((e) => [key(e.sourceSystem, e.externalId),
      e.equipmentClassSlug ? `${bySlug.get(e.equipmentClassSlug) ?? ''} ${e.equipmentClassSlug}`.trim() : null]));
  }

  private async readIn(m: EntityManager, scope: RequestScope, plantId: string): Promise<SiteLayout> {
    const { plant, machines } = await this.siteAndMachines(m, scope, plantId);
    const categories = await this.categoriesOf(m, scope, machines);
    const open = machines.length
      ? await m.getRepository(BreakdownEvent).find({
        where: { tenantId: scope.tenantId, externalId: In(machines.map((e) => e.externalId)), endedAt: IsNull() },
      })
      : [];
    const brokenDown = new Set(open.map((b) => key(b.sourceSystem, b.externalId)));
    const twin = await m.getRepository(SiteTwin).findOne({ where: { tenantId: scope.tenantId, plantId } });
    const zones = twin
      ? await m.getRepository(SiteTwinZone).find({ where: { tenantId: scope.tenantId, plantId }, order: { sortOrder: 'ASC' } })
      : [];
    const rows = twin
      ? await m.getRepository(SiteTwinPlacement).find({ where: { tenantId: scope.tenantId, plantId } })
      : [];
    // A row for a machine that has since left the site, or that the caller cannot see,
    // is not drawn.
    const here = new Set(machines.map((e) => key(e.sourceSystem, e.externalId)));
    const placements = new Map(rows
      .filter((r) => here.has(key(r.sourceSystem, r.externalId)))
      .map((r) => [key(r.sourceSystem, r.externalId), { x: r.x, z: r.z, headingDeg: r.headingDeg, route: r.route }]));
    // A structure whose machine has left the site is not drawn: the generator room goes
    // with the generator. The row stays until the layout is next saved, so a machine
    // moved away and straight back does not take the room with it.
    const shown = zones.filter((z) => {
      const backed = EQUIPMENT_BACKED[z.kind];
      return !backed || backs(backed.test, categories);
    });
    const hiddenZones = zones.filter((z) => !shown.includes(z)).map((z) => z.key);
    return {
      plant, machines, categories, brokenDown, hiddenZones,
      saved: !!twin && twin.version > 0,
      version: twin?.version ?? 0,
      updatedBy: twin?.updatedBy ?? null,
      extent: twin ? { widthM: twin.widthM, depthM: twin.depthM } : { ...DEFAULT_EXTENT },
      zones: shown.map((z) => ({
        id: z.id, key: z.key, label: z.label, kind: z.kind, x: z.x, z: z.z, widthM: z.widthM, depthM: z.depthM,
        floors: z.floors, progressPct: z.progressPct,
        progressReportedAt: z.progressReportedAt?.toISOString() ?? null, progressReportedBy: z.progressReportedBy,
      })),
      placements,
    };
  }
}

function backs(test: RegExp, categories: Map<string, string | null>): boolean {
  return [...categories.values()].some((c) => !!c && test.test(c));
}

function assertVersion(twin: SiteTwin, expected: number): void {
  if (twin.version !== expected) {
    throw new ConflictException(
      `This layout was saved by someone else since you opened it (version ${twin.version}, yours ${expected}). Reload, then make your change again.`,
    );
  }
}

/** The fit, progress and route rules are the database's; their message is the answer.
 * A deferred route check fails at commit, which is still inside this call. */
async function mapCheck<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof QueryFailedError && ['23514', '23505'].includes((err as QueryFailedError & { code?: string }).code ?? '')) {
      throw new BadRequestException(`Refused by the database: ${err.message}`);
    }
    throw err;
  }
}

export function assertSiteInScope(scope: RequestScope, plantId: string): void {
  if (scope.plantIds !== undefined && !scope.plantIds.includes(plantId)) {
    throw new NotFoundException('No such site in this account.');
  }
}

/** Any angle in, [0, 360) out, so a drag that wound past north stores the same as one
 * that did not. */
export function normaliseHeading(deg: number): number {
  const h = ((deg % 360) + 360) % 360;
  return h >= 360 ? 0 : h;
}

/** The zone a point stands in. A structure wins over the area it sits inside: a machine
 * at the batching plant is engaged at the batching plant, not "the work area". */
export function zoneAt(zones: ZoneView[], x: number, z: number): ZoneView | null {
  const inside = zones.filter((zn) => Math.abs(x - zn.x) <= zn.widthM / 2 && Math.abs(z - zn.z) <= zn.depthM / 2);
  if (!inside.length) return null;
  // The smallest containing zone is the most specific one.
  return inside.reduce((a, b) => (b.widthM * b.depthM < a.widthM * a.depthM ? b : a));
}

export { key as machineKey };
