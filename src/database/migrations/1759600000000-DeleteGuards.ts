import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deleting what was never used (dashboard testing, issue 6).
 *
 * Testing asked for delete on tool mappings, clients and abandoned invitations.
 * `ta_app` holds no DELETE on any of those tables, on purpose: people and accounts
 * are suspended, not removed, because what they did still names them. So each delete
 * is a function that checks its own rule and is the only way the application can
 * remove that kind of row, the same arrangement `delete_unused_sensor` already has.
 * A grant on the table instead would let the next code path delete without asking.
 *
 *  - `delete_unused_tool_mapping`: refused while any device uses it. The original
 *    foreign key said `ON DELETE SET NULL`, which would quietly strip the profile
 *    off every device using it, so it becomes `RESTRICT` here as well.
 *  - `delete_unused_platform_user` and `delete_unused_app_user`: only somebody who
 *    never set a password, meaning they never signed in. A client's only super
 *    admin is refused on their own, as `ck_app_user_ceo_manager_retained` already
 *    refuses demoting them; deleting the account is how they go. A client user is
 *    found through the caller's own `ta.tenant_id`, never a tenant passed in, so a
 *    session scoped to one account cannot reach into another.
 *  - `delete_unused_tenant`: a suspended account nobody signed in to that holds
 *    nothing beyond what provisioning wrote. Every tenant-owned table is checked by
 *    name from the catalog, so one added next month is covered without anyone
 *    remembering this function exists. The audit trail and the outbox are kept:
 *    they record that the account existed, which stays true.
 *
 * Each function locks the row it is about to delete first, so somebody accepting an
 * invitation at the same moment either finishes first and is refused, or waits.
 */
export class DeleteGuards1759600000000 implements MigrationInterface {
  name = 'DeleteGuards1759600000000';

  public async up(q: QueryRunner): Promise<void> {
    await this.setToolMappingOnDelete(q, 'RESTRICT');

    await q.query(`CREATE FUNCTION delete_unused_tool_mapping(target uuid) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET "ta.bypass" = 'on' AS $$
      BEGIN
        DELETE FROM tool_mapping WHERE id = target;
        RETURN FOUND;
      END $$`);

    await q.query(`CREATE FUNCTION delete_unused_platform_user(target uuid) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
      DECLARE u platform_user;
      BEGIN
        SELECT * INTO u FROM platform_user WHERE id = target FOR UPDATE;
        IF NOT FOUND THEN RETURN false; END IF;
        IF u.password_hash IS NOT NULL THEN
          RAISE EXCEPTION '% has signed in, so they can be suspended but not deleted.', u.email
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_delete_never_signed_in';
        END IF;
        DELETE FROM platform_invitation WHERE platform_user_id = target;
        DELETE FROM platform_user WHERE id = target;
        RETURN true;
      END $$`);

    await q.query(`CREATE FUNCTION delete_unused_app_user(target uuid) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET "ta.bypass" = 'on' AS $$
      DECLARE u app_user; caller text := current_setting('ta.tenant_id', true); remaining int;
      BEGIN
        IF caller IS NULL OR caller = '' THEN
          RAISE EXCEPTION 'delete_unused_app_user needs a tenant session';
        END IF;
        SELECT * INTO u FROM app_user WHERE id = target AND tenant_id = caller FOR UPDATE;
        IF NOT FOUND THEN RETURN false; END IF;
        IF u.password_hash IS NOT NULL THEN
          RAISE EXCEPTION '% has signed in, so they can be suspended but not deleted.', u.email
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_delete_never_signed_in';
        END IF;
        IF u.role_slug = 'ceo-manager' THEN
          -- Lock, then count, as the role-change guard does: a concurrent demotion of
          -- the other ceo-manager is waited for rather than raced.
          PERFORM 1 FROM app_user
            WHERE tenant_id = caller AND role_slug = 'ceo-manager' AND id <> target FOR SHARE;
          SELECT count(*) INTO remaining FROM app_user
            WHERE tenant_id = caller AND role_slug = 'ceo-manager' AND id <> target;
          IF remaining = 0 THEN
            RAISE EXCEPTION '% is the account''s only super admin. Delete the account instead.', u.email
              USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_app_user_ceo_manager_retained';
          END IF;
        END IF;
        DELETE FROM user_invitation WHERE tenant_id = caller AND user_id = target;
        DELETE FROM user_session WHERE tenant_id = caller AND user_id = target;
        DELETE FROM user_plant_access WHERE tenant_id = caller AND user_id = target;
        DELETE FROM user_equipment_access WHERE tenant_id = caller AND user_id = target;
        DELETE FROM app_user WHERE id = target;
        RETURN true;
      END $$`);

    await q.query(`CREATE FUNCTION delete_unused_tenant(target text) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET "ta.bypass" = 'on' AS $$
      DECLARE t tenant; tbl text; found_rows boolean; holding text[] := '{}';
        deleted text[] := ARRAY['user_session', 'user_invitation', 'user_plant_access', 'user_equipment_access',
                                'app_user', 'tenant_role', 'tenant_parameter', 'tenant_map'];
        kept text[] := ARRAY['tenant', 'platform_access_log', 'user_security_event', 'domain_event'];
      BEGIN
        SELECT * INTO t FROM tenant WHERE tenant_id = target FOR UPDATE;
        IF NOT FOUND THEN RETURN false; END IF;
        IF t.status <> 'suspended' THEN
          RAISE EXCEPTION 'Suspend "%" before deleting it.', target
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_delete_tenant_suspended';
        END IF;
        IF EXISTS (SELECT 1 FROM app_user WHERE tenant_id = target AND password_hash IS NOT NULL) THEN
          RAISE EXCEPTION 'Somebody has signed in to "%", so it can stay suspended but cannot be deleted.', target
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_delete_never_signed_in';
        END IF;
        FOR tbl IN
          SELECT c.table_name FROM information_schema.columns c
            JOIN pg_class k ON k.relname = c.table_name AND k.relnamespace = 'public'::regnamespace
           WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND NOT k.relispartition
             AND k.relkind IN ('r', 'p')
             AND NOT (c.table_name = ANY (deleted)) AND NOT (c.table_name = ANY (kept))
           ORDER BY c.table_name
        LOOP
          EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE tenant_id = $1)', tbl) INTO found_rows USING target;
          IF found_rows THEN holding := holding || tbl; END IF;
        END LOOP;
        IF array_length(holding, 1) > 0 THEN
          RAISE EXCEPTION '"%" already holds data (%), so it can stay suspended but cannot be deleted.',
            target, array_to_string(holding, ', ')
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_delete_tenant_unused';
        END IF;
        FOREACH tbl IN ARRAY deleted LOOP
          EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', tbl) USING target;
        END LOOP;
        DELETE FROM tenant WHERE tenant_id = target;
        RETURN true;
      END $$`);

    for (const fn of ['delete_unused_tool_mapping(uuid)', 'delete_unused_platform_user(uuid)',
      'delete_unused_app_user(uuid)', 'delete_unused_tenant(text)']) {
      await q.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
      await q.query(`GRANT EXECUTE ON FUNCTION ${fn} TO ta_app`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP FUNCTION delete_unused_tenant(text)`);
    await q.query(`DROP FUNCTION delete_unused_app_user(uuid)`);
    await q.query(`DROP FUNCTION delete_unused_platform_user(uuid)`);
    await q.query(`DROP FUNCTION delete_unused_tool_mapping(uuid)`);
    await this.setToolMappingOnDelete(q, 'SET NULL');
  }

  /** The constraint was named by Postgres, not by us, so it is looked up rather than assumed. */
  private async setToolMappingOnDelete(q: QueryRunner, action: 'RESTRICT' | 'SET NULL'): Promise<void> {
    const [row] = await q.query(`
      SELECT conname FROM pg_constraint
        WHERE conrelid = 'device_inventory'::regclass AND confrelid = 'tool_mapping'::regclass AND contype = 'f'`);
    if (row) await q.query(`ALTER TABLE device_inventory DROP CONSTRAINT "${row.conname}"`);
    await q.query(`ALTER TABLE device_inventory ADD CONSTRAINT fk_device_inventory_tool_mapping
      FOREIGN KEY (tool_mapping_id) REFERENCES tool_mapping (id) ON DELETE ${action}`);
  }
}
