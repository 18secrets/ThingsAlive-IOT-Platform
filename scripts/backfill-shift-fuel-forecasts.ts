import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/database/data-source';
import { backfillShiftFuelForecasts } from '../src/shift-fuel/shift-fuel-backfill';

/**
 * Back-calculate shift fuel forecasts for past shifts (D54), so the accuracy page has
 * something to score before the live forecast had been running long enough to.
 *
 *   DATABASE_URL=<owner url> npx ts-node scripts/backfill-shift-fuel-forecasts.ts 2026-10-06 2026-11-02
 *
 * Safe to run again: a shift that already has a forecast, live or back-calculated, is left alone.
 */
async function main() {
  const [from, to] = process.argv.slice(2);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (the owner\'s login: the app role cannot write backfilled).');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '') || from > to) {
    throw new Error('Usage: backfill-shift-fuel-forecasts.ts <from YYYY-MM-DD> <to YYYY-MM-DD>');
  }
  const ds = new DataSource(dataSourceOptions(process.env, { appRole: null }));
  await ds.initialize();
  try {
    const s = await backfillShiftFuelForecasts(ds, { from, to });
    console.log(`Back-calculated ${s.written} forecast(s) for ${s.targets} completed shift(s) with none, ${from} to ${to}.`);
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
