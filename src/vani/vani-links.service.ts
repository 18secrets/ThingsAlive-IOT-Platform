import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { withTenantId } from '../scope/tenant-session';

export interface AccountLinkInput {
  vaniAccountId: string;
  customerPhone?: string | null;
  callbackUrl?: string | null;
  enabled?: boolean;
}

export interface MachineLinkInput {
  machineId: string;
  spokenName: string;
}

export interface MachineLinkView {
  sourceSystem: string;
  externalId: string;
  machineId: string;
  spokenName: string;
}

export interface AccountLinkView {
  tenantId: string;
  vaniAccountId: string;
  customerPhone: string | null;
  callbackUrl: string | null;
  enabled: boolean;
  snapshotPushedAt: Date | null;
  snapshotError: string | null;
  machines: MachineLinkView[];
}

/**
 * Which Vani account a tenant is, and which Vani machine each of its machines is —
 * written by Things Alive staff once Vani operations have registered the customer
 * (integration guide §3). Until this existed the links were made by a seed or by hand
 * in SQL.
 *
 * Every write runs in the tenant's own session, as `ta_app`, so row-level security
 * holds for staff exactly as for anyone else: a link can only be written into the
 * tenant named in the path. The rules that stop a call reaching the wrong person —
 * one tenant per Vani account, one Vani identity per machine and back, an E.164
 * number, an https callback — are the database's. This service only turns their
 * refusals into sentences staff can act on; it does not check them first, because a
 * check here would lose to a concurrent write and the index would not.
 *
 * Writes are upserts so a repeated PUT — a retry, a double click — lands once.
 */
@Injectable()
export class VaniLinksService {
  constructor(private readonly ds: DataSource) {}

  async get(tenantId: string): Promise<AccountLinkView> {
    return withTenantId(this.ds, tenantId, async (m) => {
      const view = await this.read(m, tenantId);
      if (!view) throw new NotFoundException(`Tenant "${tenantId}" is not linked to a Vani account.`);
      return view;
    });
  }

  /**
   * Creates the link or replaces it. A field left out is cleared, not kept: what was
   * sent is what is stored, so nobody has to remember what an earlier call set.
   */
  async putAccount(tenantId: string, input: AccountLinkInput): Promise<AccountLinkView> {
    const accountId = input.vaniAccountId.trim();
    return this.refusalsAsSentences(() => withTenantId(this.ds, tenantId, async (m) => {
      await lockLinks(m, tenantId);
      await m.query(
        `INSERT INTO "vani_account_link" ("tenant_id", "vani_account_id", "customer_phone", "callback_url", "enabled")
           VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("tenant_id") DO UPDATE SET
           "vani_account_id" = EXCLUDED."vani_account_id",
           "customer_phone" = EXCLUDED."customer_phone",
           "callback_url" = EXCLUDED."callback_url",
           "enabled" = EXCLUDED."enabled",
           -- A different Vani account has seen no picture of these machines yet, and
           -- a picture the old account refused says nothing about the new one.
           "snapshot_hash" = CASE WHEN "vani_account_link"."vani_account_id" = EXCLUDED."vani_account_id"
                                  THEN "vani_account_link"."snapshot_hash" END,
           "snapshot_refused_hash" = CASE WHEN "vani_account_link"."vani_account_id" = EXCLUDED."vani_account_id"
                                          THEN "vani_account_link"."snapshot_refused_hash" END,
           "updated_at" = now()`,
        [tenantId, accountId, input.customerPhone ?? null, input.callbackUrl ?? null, input.enabled ?? true],
      );
      return (await this.read(m, tenantId))!;
    }), { tenantId, accountId });
  }

  /** Removes the link and, with it, every machine link: they mean nothing without it. */
  async deleteAccount(tenantId: string): Promise<{ removed: boolean; machinesRemoved: number }> {
    return withTenantId(this.ds, tenantId, async (m) => {
      const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM "vani_machine_link" WHERE "tenant_id" = $1`, [tenantId]);
      const [, removed] = await m.query(`DELETE FROM "vani_account_link" WHERE "tenant_id" = $1`, [tenantId]);
      if (!removed) throw new NotFoundException(`Tenant "${tenantId}" is not linked to a Vani account.`);
      return { removed: true, machinesRemoved: n };
    });
  }

  async putMachine(
    tenantId: string, sourceSystem: string, externalId: string, input: MachineLinkInput,
  ): Promise<MachineLinkView> {
    const machineId = input.machineId.trim();
    const spokenName = input.spokenName.trim();
    return this.refusalsAsSentences(() => withTenantId(this.ds, tenantId, async (m) => {
      await lockLinks(m, tenantId);
      const [row] = await m.query(
        `INSERT INTO "vani_machine_link" ("tenant_id", "source_system", "external_id", "machine_id", "spoken_name")
           VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("tenant_id", "source_system", "external_id") DO UPDATE SET
           "machine_id" = EXCLUDED."machine_id",
           "spoken_name" = EXCLUDED."spoken_name",
           "updated_at" = now()
         RETURNING "source_system", "external_id", "machine_id", "spoken_name"`,
        [tenantId, sourceSystem, externalId, machineId, spokenName],
      );
      return machineView(row);
    }), { tenantId, machineId, sourceSystem, externalId });
  }

  async deleteMachine(tenantId: string, sourceSystem: string, externalId: string): Promise<{ removed: boolean }> {
    return withTenantId(this.ds, tenantId, async (m) => {
      const [, removed] = await m.query(
        `DELETE FROM "vani_machine_link" WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3`,
        [tenantId, sourceSystem, externalId],
      );
      if (!removed) throw new NotFoundException(`${sourceSystem}/${externalId} is not linked to a Vani machine.`);
      return { removed: true };
    });
  }

  private async read(m: EntityManager, tenantId: string): Promise<AccountLinkView | null> {
    const [a] = await m.query(
      `SELECT "tenant_id", "vani_account_id", "customer_phone", "callback_url", "enabled",
              "snapshot_pushed_at", "snapshot_error"
         FROM "vani_account_link" WHERE "tenant_id" = $1`,
      [tenantId],
    );
    if (!a) return null;
    const machines = await m.query(
      `SELECT "source_system", "external_id", "machine_id", "spoken_name"
         FROM "vani_machine_link" WHERE "tenant_id" = $1 ORDER BY "machine_id"`,
      [tenantId],
    );
    return {
      tenantId: a.tenant_id,
      vaniAccountId: a.vani_account_id,
      customerPhone: a.customer_phone,
      callbackUrl: a.callback_url,
      enabled: a.enabled,
      snapshotPushedAt: a.snapshot_pushed_at,
      snapshotError: a.snapshot_error,
      machines: machines.map(machineView),
    };
  }

  /**
   * The database's refusal, said in terms of what staff typed. Keyed on the
   * constraint name, not the message text, which Postgres is free to reword.
   */
  private async refusalsAsSentences<R>(
    fn: () => Promise<R>,
    ctx: { tenantId: string; accountId?: string; machineId?: string; sourceSystem?: string; externalId?: string },
  ): Promise<R> {
    try {
      return await fn();
    } catch (e: any) {
      const c: string | undefined = e?.constraint;
      switch (c) {
        case 'uq_vani_account_link_account':
          throw new ConflictException(`Vani account "${ctx.accountId}" is already linked to another tenant. Unlink it there first.`);
        case 'uq_vani_machine_link_machine':
          throw new ConflictException(`Vani machine "${ctx.machineId}" is already linked to another machine in this tenant.`);
        case 'ck_vani_customer_phone':
          throw new BadRequestException('customerPhone must be E.164: a + and the country code, digits only.');
        case 'ck_vani_callback_url':
          throw new BadRequestException('callbackUrl must be https.');
        case 'ck_vani_account_id':
          throw new BadRequestException('vaniAccountId must not be blank.');
        case 'ck_vani_machine_id':
          throw new BadRequestException('machineId must not be blank.');
        case 'ck_vani_spoken_name':
          throw new BadRequestException('spokenName must not be blank.');
        case 'fk_vani_machine_link_account':
          throw new NotFoundException(`Tenant "${ctx.tenantId}" is not linked to a Vani account. Link the account first.`);
        case 'fk_vani_machine_link_equipment':
          throw new NotFoundException(`Tenant "${ctx.tenantId}" has no machine ${ctx.sourceSystem}/${ctx.externalId}.`);
        case 'vani_account_link_tenant_id_fkey':
          throw new NotFoundException(`No tenant "${ctx.tenantId}".`);
        default:
          throw e;
      }
    }
  }
}

/**
 * One link write per tenant at a time, until its transaction ends.
 *
 * Each link table has two unique keys and an upsert's ON CONFLICT names only one. Two
 * identical PUTs at once could therefore collide on the other key — the second refused
 * as "already linked to another machine" when it was the same link, sent twice. Found by
 * the concurrent-call test, failing about one run in six. Serialised here, the second
 * waits, then finds the row and updates it. Tenant-wide rather than per row because the
 * conflict is between rows: the key being raced for is not known before the insert.
 */
async function lockLinks(m: EntityManager, tenantId: string): Promise<void> {
  await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`vani-links|${tenantId}`]);
}

function machineView(r: { source_system: string; external_id: string; machine_id: string; spoken_name: string }): MachineLinkView {
  return { sourceSystem: r.source_system, externalId: r.external_id, machineId: r.machine_id, spokenName: r.spoken_name };
}
