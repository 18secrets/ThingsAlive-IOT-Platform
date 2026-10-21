/**
 * Fixture shim for specs written before task QFIX-DEVICES-2.
 *
 * Those specs put a device on a machine through `device_projection` alone. The readers
 * they test now ask the bindings which devices a machine has, so a fixture that wants a
 * device on a machine binds it too, the way a commissioned device really is. One binding
 * per device, on a key no reader treats as a signal: what these specs exercise is which
 * loggers are on which machine, not which signal a channel carries.
 */
export async function bindProjectedDevice(
  m: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  d: { tenantId: string; sourceSystem: string; externalId: string; imei: string },
): Promise<void> {
  // A binding names a machine 2.0 registered (`fk_signal_binding_equipment`); a spec that
  // only ever knew the machine through the projection gets the bare register row.
  await m.query(
    `INSERT INTO "equipment_profile" ("tenant_id", "source_system", "external_id", "tier", "readiness", "updated_by")
     VALUES ($1, $2, $3, 'standard', '{}'::jsonb, 'fixture') ON CONFLICT DO NOTHING`,
    [d.tenantId, d.sourceSystem, d.externalId],
  );
  await m.query(
    `INSERT INTO "signal_binding_version"
       ("tenant_id", "source_system", "external_id", "signal_key", "measurement_role", "component_id", "origin",
        "imei", "channel", "canonical_unit", "valid_from", "is_primary", "status", "discovered_by",
        "approved_by", "approved_at")
     SELECT $1, $2, $3, 'device:' || $4, 'device:' || $4, '', 'physical', $4, 'fixture', 'none',
            '2000-01-01T00:00:00Z', true, 'active', 'manual', 'fixture', '2000-01-01T00:00:00Z'
      WHERE NOT EXISTS (
        SELECT 1 FROM "signal_binding_version"
         WHERE "tenant_id" = $1 AND "source_system" = $2 AND "external_id" = $3 AND "imei" = $4)`,
    [d.tenantId, d.sourceSystem, d.externalId, d.imei],
  );
}
