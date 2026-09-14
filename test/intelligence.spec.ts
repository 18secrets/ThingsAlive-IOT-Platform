import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { CLIENT_SOURCE_SYSTEM } from '../src/equipment/equipment-profile.entity';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { PlantService } from '../src/equipment/services/plant.service';
import { ChainNode } from '../src/intelligence/services/causal-chain';
import { ChainService, validateChain } from '../src/intelligence/services/chain.service';
import { runTenantSpanning } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const OIL: ChainNode = {
  signal: 'engine_oil_temperature',
  label: 'Oil temperature under load',
  intercept: 40,
  drivers: [{ signal: 'engine_load', coefficient: 1 / 3, lagSeconds: 600 }],
  warnAbove: 8, criticalAbove: 16, limits: { warnAt: 105 },
};
const COOLANT: ChainNode = {
  signal: 'engine_coolant_temperature',
  intercept: 20,
  drivers: [{ signal: 'engine_oil_temperature', coefficient: 0.6, lagSeconds: 480 }],
  warnAbove: 6, criticalAbove: 12,
};

describe('validateChain', () => {
  /**
   * Every refusal here describes a chain that evaluates to "nothing is wrong" on every
   * machine it is bound to. That is the most expensive way for a definition to be
   * broken: it looks configured, it never fires, and nobody finds out until the failure
   * it was meant to catch has already happened.
   */
  it('accepts a well-formed chain', () => {
    expect(validateChain([OIL, COOLANT])).toBeNull();
  });

  it('refuses an empty chain', () => {
    expect(validateChain([])).toMatch(/at least one stage/);
  });

  it('refuses two stages explaining the same signal', () => {
    expect(validateChain([OIL, { ...COOLANT, signal: OIL.signal }]))
      .toMatch(/one explanation/);
  });

  it('refuses a threshold nothing can exceed', () => {
    expect(validateChain([{ ...OIL, warnAbove: 0 }])).toMatch(/positive warnAbove/);
  });

  it('refuses a critical threshold below the warning one', () => {
    expect(validateChain([{ ...OIL, warnAbove: 10, criticalAbove: 5 }]))
      .toMatch(/never/);
  });

  it('refuses a stage with no drivers', () => {
    // Its expectation would be a constant, which is a threshold rather than a chain.
    expect(validateChain([{ ...OIL, drivers: [] }])).toMatch(/threshold wearing a costume/);
  });

  it('refuses a stage that drives itself, and a negative lag', () => {
    expect(validateChain([{ ...OIL, drivers: [{ signal: OIL.signal, coefficient: 1 }] }]))
      .toMatch(/drives itself/);
    expect(validateChain([{ ...OIL, drivers: [{ ...OIL.drivers[0], lagSeconds: -60 }] }]))
      .toMatch(/effect before the cause/);
  });

  it('refuses a cycle, and says what to do about it', () => {
    const loop: ChainNode = {
      ...OIL, drivers: [{ signal: 'engine_coolant_temperature', coefficient: 1 }],
    };
    expect(validateChain([loop, COOLANT])).toMatch(/break it at the link/);
  });
});

describeDb('chain authoring and diagnosis', () => {
  let ds: DataSource;
  let owner: DataSource;
  let chains: ChainService;
  let plants: PlantService;
  let equipment: EquipmentService;

  const NOW = new Date('2026-09-14T12:00:00Z');
  const author: RequestScope = {
    tenantId: 'things-alive', userId: 'u-author', roles: ['catalog-author'],
    isPlatformRole: true, capabilities: ['catalog.write', 'catalog.read'],
  };
  const boss: RequestScope = {
    tenantId: 'acme', userId: 'u-boss', roles: ['ceo-manager'], isPlatformRole: false,
    capabilities: ['prediction.read', 'equipment.write'],
  };
  const operator: RequestScope = {
    ...boss, userId: 'u-op', equipmentIds: ['DG-1'],
  };

  const IMEI = '860123456789099';
  const ref = (externalId: string) => ({ sourceSystem: CLIENT_SOURCE_SYSTEM, externalId });

  const draft = () => ({
    equipmentClassSlug: 'dg',
    scenarioSlug: 'dg-coolant-overheat',
    name: 'Thermal path',
    outcome: 'cooling-system-maintenance',
    nodes: [OIL, COOLANT],
    alignmentSeconds: 900,
    provenance: 'Cummins QSB7 datasheet, derated curve.',
  });

  /**
   * A logger fitted to DG-1.
   *
   * The fixture that matters. Readings reach a machine through the *device* projection
   * — equipment code to IMEI — and not through the sensor map, whose `external_id` is
   * the upstream measurement id rather than the machine's. A fixture that put the
   * machine code in the sensor map would pass against a query making the same mistake
   * and fail against real data, which is exactly what happened here before this.
   */
  const fitDevice = async () => {
    await runTenantSpanning(owner, 'test fixture', (m) => m.query(
      `INSERT INTO "device_projection"
         ("tenant_id","source_system","external_id","checksum","imei","equipment_external_id",
          "payload","source_updated_at","synced_at","status")
       VALUES ('acme',$1,$2,'c',$2,'DG-1','{}'::jsonb,$3,$3,'live')
       ON CONFLICT DO NOTHING`,
      [CLIENT_SOURCE_SYSTEM, IMEI, NOW]));
  };

  /** Put a reading on the wire for this machine, `agoSeconds` before NOW. */
  const reading = async (signal: string, value: number, agoSeconds: number) => {
    await runTenantSpanning(owner, 'test fixture', (m) => m.query(
      `INSERT INTO "telemetry_reading"
         ("tenant_id","imei","signal","value","unit","source_timestamp","received_at","source")
       VALUES ('acme',$1,$2,$3,null,$4,$4,'live') ON CONFLICT DO NOTHING`,
      [IMEI, signal, value, new Date(NOW.getTime() - agoSeconds * 1000)]));
  };

  /** Load, oil and coolant placed exactly where the chain predicts, plus offsets. */
  const runMachine = async (load: number, oilOffset = 0, coolantOffset = 0) => {
    await fitDevice();
    const oil = 40 + load / 3 + oilOffset;
    const coolant = 20 + 0.6 * oil + coolantOffset;
    await reading('engine_load', load, 1080);
    await reading('engine_oil_temperature', oil, 480);
    await reading('engine_coolant_temperature', coolant, 0);
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    chains = new ChainService(ds);
    plants = new PlantService(ds);
    equipment = new EquipmentService(ds);
  }, 40_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['causal_chain', 'telemetry_reading', 'sensor_map_projection',
      'device_projection',
      'equipment_placement_event', 'equipment_profile', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    const north = (await plants.create(boss, { code: 'NORTH', name: 'Northern yard' })).id;
    await equipment.create(boss, { code: 'DG-1', name: 'Generator 1', plantId: north });
    await equipment.update(boss, ref('DG-1'), { equipmentClassSlug: 'dg' });
  });

  describe('authoring', () => {
    it('stores a draft with its provenance', async () => {
      const row = await chains.createDraft(author, 'dg-thermal', draft());
      expect(row.version).toBe(1);
      expect(row.status).toBe('draft');
      expect(row.publishedAt).toBeNull();
      // A coefficient with no provenance is a number nobody will dare change in two
      // years, because nobody will remember whether it came from a datasheet or a
      // guess in a meeting.
      expect(row.provenance).toMatch(/Cummins/);
      expect(row.nodes).toHaveLength(2);
    });

    it('refuses a broken chain before it reaches the database', async () => {
      // Finding out at three in the morning on a customer's machine is the wrong
      // moment. The author is the person who can fix it, and they are here now.
      await expect(chains.createDraft(author, 'bad', {
        ...draft(), nodes: [{ ...OIL, drivers: [] }],
      })).rejects.toThrow(BadRequestException);
      expect(await owner.query(`SELECT * FROM "causal_chain"`)).toEqual([]);
    });

    it('replaces a draft in place but versions past a published one', async () => {
      await chains.createDraft(author, 'dg-thermal', draft());
      await chains.createDraft(author, 'dg-thermal', { ...draft(), name: 'Thermal path v2' });
      // Nobody has built anything on a draft, so it is edited rather than versioned.
      expect(await owner.query(`SELECT count(*)::int AS n FROM "causal_chain"`))
        .toEqual([{ n: 1 }]);

      await chains.publish(author, 'dg-thermal');
      const next = await chains.createDraft(author, 'dg-thermal', { ...draft(), name: 'v3' });
      // A published version is immutable: clients' alerts run against it.
      expect(next.version).toBe(2);
      expect(next.status).toBe('draft');
    });

    it('publishes, and refuses to publish what is not there', async () => {
      await chains.createDraft(author, 'dg-thermal', draft());
      const published = await chains.publish(author, 'dg-thermal');
      expect(published.status).toBe('published');
      expect(published.publishedAt).toBeInstanceOf(Date);
      await expect(chains.publish(author, 'nope')).rejects.toThrow(NotFoundException);
    });

    it('offers only published chains, newest version of each', async () => {
      await chains.createDraft(author, 'dg-thermal', draft());
      await chains.publish(author, 'dg-thermal');
      await chains.createDraft(author, 'dg-thermal', { ...draft(), name: 'newer draft' });
      await chains.createDraft(author, 'dg-other', { ...draft(), name: 'Other' });

      const live = await chains.publishedFor('dg');
      expect(live.map((c) => c.slug)).toEqual(['dg-thermal']);
      expect(live[0].version).toBe(1);
    });
  });

  describe('diagnosis', () => {
    beforeEach(async () => {
      await chains.createDraft(author, 'dg-thermal', draft());
      await chains.publish(author, 'dg-thermal');
    });

    it('reads a machine on its curve as normal', async () => {
      await runMachine(60);
      const d = await chains.diagnose(boss, ref('DG-1'), NOW);
      expect(d.chains).toHaveLength(1);
      expect(d.chains[0].evaluated).toBe(true);
      expect(d.chains[0].origin).toBeUndefined();
    });

    it('names the stage where a fault entered, from real telemetry', async () => {
      await runMachine(60, 18);
      const d = await chains.diagnose(boss, ref('DG-1'), NOW);
      const [chain] = d.chains;
      expect(chain.origin!.signal).toBe('engine_oil_temperature');
      expect(chain.origin!.severity).toBe('critical');
      // And the coolant, which is also hot, is reported as explained by it rather than
      // as a second problem.
      expect(chain.explainedBy).toEqual([
        { signal: 'engine_coolant_temperature', because: 'engine_oil_temperature' },
      ]);
    });

    it('will not run somebody else\'s physics on an unclassified machine', async () => {
      // A compressor scored on a generator's thermal curve produces confident nonsense,
      // and the class binding is the only thing standing between those two.
      await equipment.create(boss, { code: 'MYSTERY', name: 'Unclassified' });
      const d = await chains.diagnose(boss, ref('MYSTERY'), NOW);
      expect(d.chains).toEqual([]);
      expect(d.skipped[0].reason).toMatch(/no equipment class/);
    });

    it('says so when a class has no chain yet', async () => {
      await equipment.create(boss, { code: 'CNC-1', name: 'Mill' });
      await equipment.update(boss, ref('CNC-1'), { equipmentClassSlug: 'cnc' });
      const d = await chains.diagnose(boss, ref('CNC-1'), NOW);
      expect(d.skipped[0].reason).toMatch(/No published chain for class "cnc"/);
    });

    it('reports what it could not evaluate rather than calling the machine healthy', async () => {
      // Only the load reported. Nothing downstream can be scored, and silence here
      // would read identically to a machine behaving perfectly.
      await fitDevice();
      await reading('engine_load', 60, 1080);
      const d = await chains.diagnose(boss, ref('DG-1'), NOW);
      expect(d.chains[0].evaluated).toBe(false);
      expect(d.chains[0].reason).toBe('nothing-evaluable');
    });

    it('keeps one account\'s machines out of another\'s diagnosis', async () => {
      await runMachine(60);
      const stranger: RequestScope = { ...boss, tenantId: 'globex' };
      await expect(chains.diagnose(stranger, ref('DG-1'), NOW)).rejects.toThrow(NotFoundException);
    });

    it('refuses a machine outside an operator\'s assignment', async () => {
      await equipment.create(boss, { code: 'DG-2', name: 'Generator 2' });
      await expect(chains.diagnose(operator, ref('DG-2'), NOW)).rejects.toThrow(NotFoundException);
      await runMachine(60);
      await expect(chains.diagnose(operator, ref('DG-1'), NOW)).resolves.toBeDefined();
    });
  });

  describe('projection', () => {
    beforeEach(async () => {
      await chains.createDraft(author, 'dg-thermal', draft());
      await chains.publish(author, 'dg-thermal');
    });

    it('says where the chain ends up and how long it takes to get there', async () => {
      const p = await chains.project(boss, 'dg-thermal', { engine_load: 95 });
      const oil = p.stages.find((s) => s.signal === 'engine_oil_temperature')!;
      expect(oil.expected).toBeCloseTo(40 + 95 / 3, 3);
      expect(oil.leadSeconds).toBe(600);
      expect(p.stages.find((s) => s.signal === 'engine_coolant_temperature')!.leadSeconds)
        .toBe(1080);
    });

    it('refuses a chain nobody published', async () => {
      await expect(chains.project(boss, 'nope', { engine_load: 50 }))
        .rejects.toThrow(NotFoundException);
    });
  });
});
