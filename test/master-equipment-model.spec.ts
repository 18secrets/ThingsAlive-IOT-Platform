import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { ClientEquipmentClass } from '../src/client-catalog/entities/client-equipment-class.entity';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { ClientEquipmentTemplateService } from '../src/equipment-template/services/client-equipment-template.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

jest.setTimeout(60_000);

/**
 * Master Admin names a machine's model on an account's behalf (17 Nov 2026). The Add
 * equipment form of the cross-tenant Equipment page offered a free-text model number only,
 * so a pump made there had no model (D57) and its rated alerts idled until the client
 * set one. The account's models are read on the equipment register's on-behalf-of path,
 * which is Things Alive staff's alone; a client asking it for another account is refused.
 */
describeDb('Master Admin: an account\'s models, and a machine\'s model on its behalf', () => {
  let owner: DataSource;
  let ds: DataSource;
  let models: ClientEquipmentTemplateService;
  let equipment: EquipmentService;

  const master: RequestScope = { tenantId: '', userId: 'u-master', roles: [], isPlatformRole: true };
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };
  const other: RequestScope = { tenantId: 'other', userId: 'u-other', roles: ['super admin'], isPlatformRole: false };
  const CLASS = 'motor-1ph';
  const PUMP = { sourceSystem: CLIENT_SOURCE_SYSTEM, externalId: 'PUMP-1' };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    models = new ClientEquipmentTemplateService(ds);
    equipment = new EquipmentService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['equipment_model', 'equipment_profile', 'client_equipment_template', 'client_equipment_class']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    for (const tenantId of ['acme', 'other']) {
      await owner.query(`INSERT INTO "tenant" ("tenant_id", "name") VALUES ($1, $1) ON CONFLICT DO NOTHING`, [tenantId]);
      await owner.getRepository(ClientEquipmentClass).save({
        tenantId, slug: CLASS, name: CLASS, description: null, category: 'motor',
        expectedSignals: [], failureModes: [], defaultThresholds: {}, templateSlug: CLASS, templateVersion: 1,
        templateChecksum: 'c', copiedAt: new Date(), status: 'active', updatedBy: 'u-master',
      });
    }
  });

  it('reads one account\'s models, and only that account\'s', async () => {
    const mine = await models.create(acme, { name: 'Mini 1 HP', equipmentClassSlug: CLASS });
    await models.create(other, { name: 'Other 2 HP', equipmentClassSlug: CLASS });
    const read = await equipment.accountModels(master, 'acme');
    expect(read.map((m) => [m.id, m.name])).toEqual([[mine.id, 'Mini 1 HP']]);
  });

  it('refuses a client asking for another account\'s models, and a read that names no account', async () => {
    await models.create(other, { name: 'Other 2 HP', equipmentClassSlug: CLASS });
    await expect(equipment.accountModels(acme, 'other')).rejects.toThrow(ForbiddenException);
    await expect(equipment.accountModels(master, '  ')).rejects.toThrow(BadRequestException);
  });

  it('creates a machine for the account and names its model, as the form does', async () => {
    const model = await models.create(acme, { name: 'Mini 1 HP', equipmentClassSlug: CLASS });
    await equipment.create(master, { code: PUMP.externalId, name: 'Pump 1', equipmentClassSlug: CLASS }, 'acme');
    await equipment.setModel(master, PUMP, model.id, 'acme');
    expect(await equipment.model(master, PUMP, 'acme')).toEqual({ modelId: model.id });
    // The account sees the same model on its own machine.
    expect(await equipment.model(acme, PUMP)).toEqual({ modelId: model.id });
  });

  it('refuses naming another account\'s model on this account\'s machine', async () => {
    const theirs = await models.create(other, { name: 'Other 2 HP', equipmentClassSlug: CLASS });
    await equipment.create(master, { code: PUMP.externalId, name: 'Pump 1', equipmentClassSlug: CLASS }, 'acme');
    await expect(equipment.setModel(master, PUMP, theirs.id, 'acme')).rejects.toThrow();
    expect(await equipment.model(master, PUMP, 'acme')).toEqual({ modelId: null });
  });
});
