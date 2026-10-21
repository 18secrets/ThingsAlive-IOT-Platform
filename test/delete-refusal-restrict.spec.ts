import { ConflictException } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { DeviceCatalogService } from '../src/device-catalog/services/device-catalog.service';
import { Sensor } from '../src/device-catalog/entities/sensor.entity';
import { SensorCategory } from '../src/device-catalog/entities/sensor-category.entity';
import { ToolMapping } from '../src/device-catalog/entities/tool-mapping.entity';
import { rethrowDeleteRefusal } from '../src/identity/delete-refusal';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * A delete refused because other rows still point at it is a 409, whichever Postgres
 * refuses it. Up to 16 an ON DELETE RESTRICT key reports 23503; 18 reports 23001
 * (restrict_violation), and until this was mapped the refusal reached the person as a
 * 500 with the raw database error behind it. CI runs 16 and local dev here runs 18, so
 * both codes are pinned by hand below and the real refusal is exercised against
 * whichever server the suite has.
 */
describe('a delete refused by a RESTRICT key', () => {
  const refusal = (code: string) =>
    new QueryFailedError('DELETE FROM tool_mapping WHERE id = $1', ['x'], Object.assign(new Error('refused'), { code }));

  it.each(['23503', '23001'])('is a 409 when the database reports %s', (code) => {
    expect(() => rethrowDeleteRefusal(refusal(code))).toThrow(ConflictException);
  });

  it('lets any other database error through unchanged', () => {
    const other = refusal('40001');
    expect(() => rethrowDeleteRefusal(other)).toThrow(other);
  });
});

describeDb('deleting a tool mapping a device still uses', () => {
  let owner: DataSource;
  let ds: DataSource;
  let catalog: DeviceCatalogService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    catalog = new DeviceCatalogService(ds.getRepository(SensorCategory), ds.getRepository(Sensor), ds.getRepository(ToolMapping));
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  it('is refused as a 409 and leaves the mapping and the device as they were', async () => {
    const [{ id }] = await owner.query(`INSERT INTO tool_mapping (tool_name) VALUES ('Genset kit') RETURNING id`);
    await owner.query(`INSERT INTO device_inventory (imei, tool_mapping_id) VALUES ('861000000000101', $1)`, [id]);

    await expect(catalog.deleteToolMapping(id)).rejects.toThrow(ConflictException);

    const [{ n: mappings }] = await owner.query(`SELECT count(*) AS n FROM tool_mapping WHERE id = $1`, [id]);
    const [{ n: devices }] = await owner.query(`SELECT count(*) AS n FROM device_inventory WHERE tool_mapping_id = $1`, [id]);
    expect(Number(mappings)).toBe(1);
    expect(Number(devices)).toBe(1);
  });
});
