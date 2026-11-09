import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { withTenantSession } from '../scope/tenant-session';
import { parseRosterWorkbook, RosterRow } from './roster-workbook';

export interface RegionInput {
  code: string;
  name: string;
  /** Site (plant) codes, as on the Sites page. */
  siteCodes: string[];
  /** In the order they take a job, unless a rank says otherwise. */
  engineers: { email: string; rank?: number }[];
}

export interface RosterRegion {
  code: string;
  name: string;
  sites: { id: string; code: string; name: string }[];
  engineers: { userId: string; email: string; fullName: string; status: string; rank: number }[];
}

export interface RosterRowError {
  /** The Excel row, when the region came from a file. */
  row?: number;
  region: string;
  message: string;
}

export interface RosterPlan {
  valid: boolean;
  regions: { code: string; name: string; sites: number; engineers: number }[];
  errors: RosterRowError[];
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** Per-account lock key space for roster writes; hashed with the tenant id. */
const LOCK_PREFIX = 'service_roster:';

interface ResolvedRegion {
  code: string;
  name: string;
  plantIds: string[];
  engineers: { userId: string; rank: number }[];
}

/**
 * The service roster (Crompton U5): regions of sites, and the engineers who cover them.
 *
 * Two ways in, one set of rules. The screen edits a region at a time; the Excel upload
 * replaces the whole roster, because a roster is a list somebody keeps in a spreadsheet
 * and the file they upload is the truth, not a patch on top of whatever was there.
 * Either way every row is resolved and checked before anything is written, and the
 * write is one transaction under a per-account lock: two uploads at once would
 * otherwise each delete the other's half-written roster.
 */
@Injectable()
export class ServiceRosterService {
  constructor(private readonly ds: DataSource) {}

  async list(scope: RequestScope): Promise<RosterRegion[]> {
    this.requireAccount(scope);
    return withTenantSession(this.ds, scope, (m) => this.read(m, scope.tenantId));
  }

  /** Create or replace one region: its name, its sites and its engineers in order. */
  async putRegion(scope: RequestScope, input: RegionInput, actor = scope.userId): Promise<RosterRegion> {
    this.requireAccount(scope);
    return withTenantSession(this.ds, scope, async (m) => {
      await this.lock(m, scope.tenantId);
      const errors: RosterRowError[] = [];
      const [resolved] = await this.resolve(m, scope.tenantId, [{ input, rows: new Map() }], errors);
      // A site already in another region is refused rather than moved: moving it would
      // silently change who answers for it, and the person editing this region may not
      // be looking at the other one.
      if (resolved) {
        const taken: { code: string; region_code: string }[] = await m.query(
          `SELECT p."code", rp."region_code" FROM "service_region_plant" rp
             JOIN "plant" p ON p."tenant_id" = rp."tenant_id" AND p."id" = rp."plant_id"
            WHERE rp."tenant_id" = $1 AND rp."plant_id" = ANY($2::uuid[]) AND rp."region_code" <> $3`,
          [scope.tenantId, resolved.plantIds, resolved.code],
        );
        for (const t of taken) {
          errors.push({ region: input.code, message: `Site ${t.code} is already in region ${t.region_code}. Take it out of there first.` });
        }
      }
      if (errors.length || !resolved) throw new BadRequestException({ message: 'The region was not saved.', errors });
      await m.query(`DELETE FROM "service_region" WHERE "tenant_id" = $1 AND "code" = $2`, [scope.tenantId, resolved.code]);
      await this.write(m, scope.tenantId, [resolved], actor);
      const all = await this.read(m, scope.tenantId);
      return all.find((r) => r.code === resolved.code)!;
    });
  }

  async removeRegion(scope: RequestScope, code: string): Promise<void> {
    this.requireAccount(scope);
    await withTenantSession(this.ds, scope, async (m) => {
      await this.lock(m, scope.tenantId);
      const rows: unknown[] = await m.query(
        `DELETE FROM "service_region" WHERE "tenant_id" = $1 AND "code" = $2 RETURNING "code"`, [scope.tenantId, code]);
      if (!rows.length) throw new NotFoundException(`No region ${code}.`);
    });
  }

  /** What an upload would do, row by row. Writes nothing. */
  async planImport(scope: RequestScope, file: Buffer): Promise<RosterPlan> {
    this.requireAccount(scope);
    const rows = await parseRosterWorkbook(file);
    return withTenantSession(this.ds, scope, async (m) => {
      const { resolved, errors } = await this.fromRows(m, scope.tenantId, rows);
      return this.plan(resolved, errors);
    });
  }

  /** Replace the whole roster with the file's. Refused whole on any row error. */
  async applyImport(scope: RequestScope, file: Buffer): Promise<RosterPlan> {
    this.requireAccount(scope);
    const rows = await parseRosterWorkbook(file);
    return withTenantSession(this.ds, scope, async (m) => {
      await this.lock(m, scope.tenantId);
      const { resolved, errors } = await this.fromRows(m, scope.tenantId, rows);
      const plan = this.plan(resolved, errors);
      if (!plan.valid) throw new BadRequestException({ message: 'Nothing was imported: fix the rows below and upload again.', ...plan });
      await m.query(`DELETE FROM "service_region" WHERE "tenant_id" = $1`, [scope.tenantId]);
      await this.write(m, scope.tenantId, resolved, scope.userId);
      return plan;
    });
  }

  // ---------------------------------------------------------------------- internals

  private plan(resolved: ResolvedRegion[], errors: RosterRowError[]): RosterPlan {
    return {
      valid: errors.length === 0,
      regions: resolved.map((r) => ({ code: r.code, name: r.name, sites: r.plantIds.length, engineers: r.engineers.length })),
      errors,
    };
  }

  /** Rows → regions, keeping which Excel row said what, so errors point at a row. */
  private async fromRows(m: EntityManager, tenantId: string, rows: RosterRow[]) {
    const errors: RosterRowError[] = [];
    const groups = new Map<string, { input: RegionInput; rows: Map<string, number>; firstRow: number }>();
    for (const { row, values } of rows) {
      const code = values.regionCode;
      if (!code) { errors.push({ row, region: '', message: 'Region code is empty.' }); continue; }
      let g = groups.get(code);
      if (!g) {
        g = { input: { code, name: '', siteCodes: [], engineers: [] }, rows: new Map(), firstRow: row };
        groups.set(code, g);
      }
      if (values.regionName) {
        if (g.input.name && g.input.name !== values.regionName) {
          errors.push({ row, region: code, message: `Region name "${values.regionName}" differs from "${g.input.name}" above.` });
        } else g.input.name = values.regionName;
      }
      for (const site of values.siteCodes.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!g.input.siteCodes.includes(site)) { g.input.siteCodes.push(site); g.rows.set(`site:${site}`, row); }
      }
      if (values.engineerEmail) {
        let rank: number | undefined;
        if (values.rank) {
          rank = Number(values.rank);
          if (!Number.isInteger(rank) || rank < 1 || rank > 20) {
            errors.push({ row, region: code, message: `Rank "${values.rank}" must be a whole number from 1 to 20.` });
            rank = undefined;
          }
        }
        g.input.engineers.push({ email: values.engineerEmail, rank });
        g.rows.set(`engineer:${values.engineerEmail.toLowerCase()}`, row);
      }
    }
    // A site in two regions of the same file: the database would refuse the second, but
    // only after the first was written, and with no row to point at.
    const siteRegion = new Map<string, string>();
    for (const g of groups.values()) {
      for (const site of g.input.siteCodes) {
        const other = siteRegion.get(site);
        if (other) errors.push({ row: g.rows.get(`site:${site}`), region: g.input.code, message: `Site ${site} is also in region ${other}.` });
        else siteRegion.set(site, g.input.code);
      }
    }
    const resolved = await this.resolve(m, tenantId, [...groups.values()].map((g) => ({ input: g.input, rows: g.rows, firstRow: g.firstRow })), errors);
    return { resolved, errors };
  }

  /** Codes and emails → ids, every rule checked, every failure collected. */
  private async resolve(
    m: EntityManager, tenantId: string,
    groups: { input: RegionInput; rows: Map<string, number>; firstRow?: number }[], errors: RosterRowError[],
  ): Promise<ResolvedRegion[]> {
    const siteCodes = [...new Set(groups.flatMap((g) => g.input.siteCodes))];
    const emails = [...new Set(groups.flatMap((g) => g.input.engineers.map((e) => e.email.trim().toLowerCase())))];
    const plants: { id: string; code: string }[] = siteCodes.length
      ? await m.query(`SELECT "id", "code" FROM "plant" WHERE "tenant_id" = $1 AND "code" = ANY($2::text[])`, [tenantId, siteCodes])
      : [];
    const users: { id: string; email: string; status: string }[] = emails.length
      ? await m.query(`SELECT "id", "email", "status" FROM "app_user" WHERE "tenant_id" = $1 AND "email" = ANY($2::text[])`, [tenantId, emails])
      : [];
    const plantByCode = new Map(plants.map((p) => [p.code, p.id]));
    const userByEmail = new Map(users.map((u) => [u.email, u]));

    const out: ResolvedRegion[] = [];
    for (const { input, rows, firstRow } of groups) {
      const code = input.code.trim();
      const at = (key?: string) => (key && rows.get(key)) || firstRow;
      if (!CODE.test(code)) {
        errors.push({ row: firstRow, region: code, message: 'Region code: letters, digits, - and _ only, at most 40.' });
        continue;
      }
      const name = input.name.trim();
      if (!name) errors.push({ row: firstRow, region: code, message: 'The region has no name.' });
      const plantIds: string[] = [];
      for (const site of input.siteCodes) {
        const id = plantByCode.get(site.trim());
        if (!id) errors.push({ row: at(`site:${site}`), region: code, message: `No site ${site} in this account.` });
        else plantIds.push(id);
      }
      // Explicit ranks first, then the rest take the next free ranks in file order.
      const engineers: { userId: string; rank: number }[] = [];
      const taken = new Set<number>();
      const seen = new Set<string>();
      const pending: { userId: string }[] = [];
      for (const e of input.engineers) {
        const email = e.email.trim().toLowerCase();
        const where = at(`engineer:${email}`);
        const user = userByEmail.get(email);
        if (!user) { errors.push({ row: where, region: code, message: `${e.email} is not a user of this account. Invite them first.` }); continue; }
        if (user.status === 'suspended') { errors.push({ row: where, region: code, message: `${e.email} is suspended and cannot take jobs.` }); continue; }
        if (seen.has(user.id)) { errors.push({ row: where, region: code, message: `${e.email} is listed twice in this region.` }); continue; }
        seen.add(user.id);
        if (e.rank !== undefined) {
          if (taken.has(e.rank)) { errors.push({ row: where, region: code, message: `Rank ${e.rank} is used twice in this region.` }); continue; }
          taken.add(e.rank);
          engineers.push({ userId: user.id, rank: e.rank });
        } else pending.push({ userId: user.id });
      }
      let next = 1;
      for (const p of pending) {
        while (taken.has(next)) next++;
        if (next > 20) { errors.push({ row: firstRow, region: code, message: 'A region takes at most 20 engineers.' }); break; }
        taken.add(next);
        engineers.push({ userId: p.userId, rank: next });
      }
      out.push({ code, name, plantIds, engineers });
    }
    return out;
  }

  private async write(m: EntityManager, tenantId: string, regions: ResolvedRegion[], actor: string): Promise<void> {
    for (const r of regions) {
      await m.query(
        `INSERT INTO "service_region" ("tenant_id", "code", "name", "updated_by") VALUES ($1, $2, $3, $4)`,
        [tenantId, r.code, r.name, actor],
      );
      for (const plantId of r.plantIds) {
        await m.query(
          `INSERT INTO "service_region_plant" ("tenant_id", "plant_id", "region_code") VALUES ($1, $2, $3)`,
          [tenantId, plantId, r.code],
        );
      }
      for (const e of r.engineers) {
        await m.query(
          `INSERT INTO "service_region_engineer" ("tenant_id", "region_code", "user_id", "rank") VALUES ($1, $2, $3, $4)`,
          [tenantId, r.code, e.userId, e.rank],
        );
      }
    }
  }

  private async read(m: EntityManager, tenantId: string): Promise<RosterRegion[]> {
    const regions: { code: string; name: string }[] = await m.query(
      `SELECT "code", "name" FROM "service_region" WHERE "tenant_id" = $1 ORDER BY "code"`, [tenantId]);
    const sites: { region_code: string; id: string; code: string; name: string }[] = await m.query(
      `SELECT rp."region_code", p."id", p."code", p."name" FROM "service_region_plant" rp
         JOIN "plant" p ON p."tenant_id" = rp."tenant_id" AND p."id" = rp."plant_id"
        WHERE rp."tenant_id" = $1 ORDER BY p."code"`, [tenantId]);
    const engineers: { region_code: string; user_id: string; email: string; full_name: string; status: string; rank: number }[] = await m.query(
      `SELECT e."region_code", e."user_id", u."email", u."full_name", u."status", e."rank" FROM "service_region_engineer" e
         JOIN "app_user" u ON u."tenant_id" = e."tenant_id" AND u."id" = e."user_id"
        WHERE e."tenant_id" = $1 ORDER BY e."rank"`, [tenantId]);
    return regions.map((r) => ({
      code: r.code,
      name: r.name,
      sites: sites.filter((s) => s.region_code === r.code).map((s) => ({ id: s.id, code: s.code, name: s.name })),
      engineers: engineers.filter((e) => e.region_code === r.code).map((e) => ({
        userId: e.user_id, email: e.email, fullName: e.full_name, status: e.status, rank: Number(e.rank),
      })),
    }));
  }

  private async lock(m: EntityManager, tenantId: string): Promise<void> {
    await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [LOCK_PREFIX + tenantId]);
  }

  /** The roster is the account's own; staff have no account to route within. */
  private requireAccount(scope: RequestScope): void {
    if (scope.isPlatformRole || !scope.tenantId) {
      throw new ForbiddenException('The service roster belongs to an account. Sign in to that account to edit it.');
    }
  }
}
