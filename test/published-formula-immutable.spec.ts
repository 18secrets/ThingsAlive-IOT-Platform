import { DataSource } from 'typeorm';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'PublishedClassImmutable1759300000000';

/**
 * D-007, phase 1 manual testing (T9): the database let the app's own role rewrite a
 * published formula's expression. Asserted by attempting it — as the app role and as
 * the owner — and expecting the database to refuse, and by showing a draft still edits.
 */
describeDb('a published class version\'s formulas are immutable (D-007)', () => {
  let owner: DataSource;
  let app: DataSource;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    app = await createAppDataSource();
  }, 60_000);

  afterAll(async () => { await app?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`DELETE FROM equipment_class_formula WHERE class_slug LIKE 'imm-%'`).catch(() => undefined);
  });

  /** A class version with one formula, in the given status. The formula goes in while
   * it is a draft, then the status moves — the order the service follows. */
  let n = 0;
  const classWithFormula = async (status: 'draft' | 'published' | 'retired') => {
    n += 1;
    const slug = `imm-${n}`;
    await owner.query(
      `INSERT INTO equipment_class_profile (slug, version, name, category, status) VALUES ($1, 1, $1, 'Test', 'draft')`, [slug],
    );
    await owner.query(
      `INSERT INTO equipment_class_formula (class_slug, class_version, formula_key, kind, expression)
         VALUES ($1, 1, 'avg_x', 'empirical', 'avg(x)')`, [slug],
    );
    if (status !== 'draft') await owner.query(`UPDATE equipment_class_profile SET status = $2 WHERE slug = $1`, [slug, status]);
    return slug;
  };
  const expression = async (slug: string) =>
    (await owner.query(`SELECT expression FROM equipment_class_formula WHERE class_slug = $1`, [slug]))[0]?.expression;

  it('the app role cannot rewrite a published formula\'s expression', async () => {
    const slug = await classWithFormula('published');
    await expect(app.query(`UPDATE equipment_class_formula SET expression = '1' WHERE class_slug = $1`, [slug]))
      .rejects.toThrow(/ck_class_content_draft_only/);
    expect(await expression(slug)).toBe('avg(x)');
  });

  it('not even the owner can rewrite or delete it', async () => {
    const slug = await classWithFormula('published');
    await expect(owner.query(`UPDATE equipment_class_formula SET expression = '1' WHERE class_slug = $1`, [slug]))
      .rejects.toThrow(/ck_class_content_draft_only/);
    await expect(owner.query(`DELETE FROM equipment_class_formula WHERE class_slug = $1`, [slug]))
      .rejects.toThrow(/ck_class_content_draft_only/);
    expect(await expression(slug)).toBe('avg(x)');
  });

  it('a retired version is just as fixed as a published one', async () => {
    const slug = await classWithFormula('retired');
    await expect(owner.query(`UPDATE equipment_class_formula SET expression = '1' WHERE class_slug = $1`, [slug]))
      .rejects.toThrow(/that class version is "retired"/);
  });

  it('the seeder flag does not open a library class — its exemption is seed-only classes', async () => {
    const slug = await classWithFormula('published');
    await expect(owner.transaction(async (m) => {
      await m.query(`SELECT set_config('ta.seed_demo', 'on', true)`);
      await m.query(`DELETE FROM equipment_class_formula WHERE class_slug = $1`, [slug]);
    })).rejects.toThrow(/ck_class_content_draft_only/);
    expect(await expression(slug)).toBe('avg(x)');
  });

  it('a draft still edits freely — the guard is about publication, not formulas', async () => {
    const slug = await classWithFormula('draft');
    await owner.query(`UPDATE equipment_class_formula SET expression = 'max(x)' WHERE class_slug = $1`, [slug]);
    expect(await expression(slug)).toBe('max(x)');
  });

  it(`down path (${MIGRATION}): the formula trigger is gone, the other content guards stay`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const triggers = (await owner.query(`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_equipment_class_%_draft_only'`))
      .map((r: { tgname: string }) => r.tgname);
    expect(triggers).not.toContain('trg_equipment_class_formula_draft_only');
    expect(triggers).toContain('trg_equipment_class_failure_mode_draft_only');
    await owner.runMigrations({ transaction: 'all' });
  });
});
