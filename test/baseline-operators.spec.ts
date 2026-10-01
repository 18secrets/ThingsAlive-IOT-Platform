import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import {
  alertExcludedRanges, baselineAvg, baselineSd, deltaRatio, MIN_BASELINE_DAYS,
  openWorkOrderExcludedRanges, Reading, zscore,
} from '../src/catalog/formula/baseline-operators';
import { compileFormula, DeclaredSignal } from '../src/catalog/formula/formula-compiler';
import { NamedFormula } from '../src/catalog/entities/named-formula.entity';
import { NamedFormulaService } from '../src/catalog/services/named-formula.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

const scope: RequestScope = { tenantId: '', userId: 'deepak', roles: [], isPlatformRole: true };

const DAY = 86_400_000;
const flatHistory = (days: number, value: number, endingBefore: Date): Reading[] =>
  Array.from({ length: days }, (_, i) => ({
    at: new Date(endingBefore.getTime() - (days - i) * DAY),
    value,
  }));

/**
 * The four baseline operators (task QCE4): a rolling comparison against a machine's
 * own recent history, closing the gap `itdc-coverage-analysis.md` §3 names — D34
 * compares a signal to a fixed threshold, and nothing before this could say "versus
 * its last 90 days". No new rule kind, no new engine: four entries in the existing
 * operator registry (`operator-registry.ts`), plus a new `duration` literal in the
 * expression grammar (`parser.ts`) since none existed to reuse — see the comment on
 * `duration` there for why the spelling still matches `aggregation_window`'s tokens.
 *
 * Runtime execution is QCE2's job and does not exist yet, so the arithmetic this
 * task owns (current-period exclusion, the 14-day minimum, dirty-window exclusion)
 * is proven here as pure functions over caller-supplied readings
 * (`baseline-operators.ts`), not against live telemetry.
 */
describe('baseline operators (QCE4)', () => {
  const SIGNALS: DeclaredSignal[] = [
    { signal: 'coolant_temp_c', unit: 'degC' },
    { signal: 'oil_pressure_kpa', unit: 'kPa' },
    { signal: 'vibration_mm_s', unit: 'mm/s' },
  ];
  const compile = (expression: string) => compileFormula({
    formulaKey: 'test_formula', expression, classSlug: 'diesel-generator', expectedSignals: SIGNALS,
  });

  describe('duration literal (parser)', () => {
    it('1. parses day and hour suffixes', () => {
      expect(compile('baseline_avg(coolant_temp_c, 90d)').resultUnit).toBe('degC');
      expect(compile('baseline_avg(coolant_temp_c, 24h)').resultUnit).toBe('degC');
    });

    it('2. a bare number is not a duration, and a duration is not a bare scalar', () => {
      expect(() => compile('baseline_avg(coolant_temp_c, 5)'))
        .toThrow(/"baseline_avg" with argument 2 as scalar; it takes duration/);
      expect(() => compile('avg(90d)'))
        .toThrow(/"avg" with argument 1 as duration; it takes series/);
    });

    it('3. "90days" is not misread as "90d" — it is the same unknown-token refusal the grammar already gave', () => {
      expect(() => compile('baseline_avg(coolant_temp_c, 90days)')).toThrow(/position/);
    });
  });

  describe('compiler inference', () => {
    it('4. baseline_avg / baseline_sd stay a series, in the signal\'s own unit', () => {
      const avg = compile('baseline_avg(coolant_temp_c, 90d)');
      expect(avg.resultKind).toBe('series');
      expect(avg.resultUnit).toBe('degC');
      const sd = compile('baseline_sd(coolant_temp_c, 90d)');
      expect(sd.resultKind).toBe('series');
      expect(sd.resultUnit).toBe('degC');
    });

    it('5. zscore and delta_ratio are a series, but dimensionless — the ratio cancels the unit', () => {
      const z = compile('zscore(coolant_temp_c, 90d)');
      expect(z.resultKind).toBe('series');
      expect(z.resultUnit).toBe('dimensionless');
      const d = compile('delta_ratio(coolant_temp_c, 7d, 90d)');
      expect(d.resultKind).toBe('series');
      expect(d.resultUnit).toBe('dimensionless');
    });

    it('6. a threshold rule reading "zscore(...) > 2" needs nothing new here: the expression compiles to a dimensionless series, and ">2" is an ordinary alert-rule bound (min/max), not new grammar — this parser has no comparison operator and QCE4 does not add one', () => {
      expect(() => compile('zscore(coolant_temp_c, 90d)')).not.toThrow();
    });

    it('7. the cross-sensor risk score composes as arithmetic over several z-scores', () => {
      const summed = compile(
        'zscore(coolant_temp_c, 90d) + zscore(oil_pressure_kpa, 90d) + zscore(vibration_mm_s, 90d)',
      );
      expect(summed.resultKind).toBe('series');
      expect(summed.resultUnit).toBe('dimensionless');
    });

    it('8. what does not compose: "a count of how many exceed 2" has no expressible shape today — '
      + 'there is no comparison operator in this grammar and no boolean-to-number cast in the registry, '
      + 'so a z-score cannot become a 0/1 to sum. Reported, not worked around with a new operator.', () => {
      expect(() => compile('count(zscore(coolant_temp_c, 90d) > 2)')).toThrow();
    });
  });

  describe('reference arithmetic (baseline-operators.ts)', () => {
    const asOf = new Date('2026-09-22T00:00:00.000Z');

    it('9. the current period is excluded from its own baseline: a flat history plus one extreme '
      + 'current reading leaves baseline_avg unchanged, and the z-score is large', () => {
      const history = flatHistory(20, 50, asOf);
      const withExtremeNow = [...history, { at: asOf, value: 999 }];

      const avg = baselineAvg(withExtremeNow, asOf, 20 * 24);
      expect(avg).toEqual({ established: true, value: 50 });

      const z = zscore(999, withExtremeNow, asOf, 20 * 24);
      expect(z.established).toBe(true);
      // sd is 0 over an exactly-flat history; dividing by it is deliberately not
      // special-cased away (see baseline-operators.ts) — Infinity reads as "large".
      expect((z as { value: number }).value).toBe(Infinity);
    });

    it(`10. ${MIN_BASELINE_DAYS - 1} days of history is baseline_not_established; `
      + `${MIN_BASELINE_DAYS + 1} days is a number`, () => {
      const short = flatHistory(MIN_BASELINE_DAYS - 1, 50, asOf);
      expect(baselineAvg(short, asOf, 90 * 24)).toEqual({
        established: false, reason: 'baseline_not_established',
      });

      const long = flatHistory(MIN_BASELINE_DAYS + 1, 50, asOf);
      expect(baselineAvg(long, asOf, 90 * 24)).toEqual({ established: true, value: 50 });
    });

    it('11. delta_ratio\'s short leg (w1) is not held to the 14-day minimum — only the long leg (w2) is', () => {
      const history = flatHistory(90, 50, asOf);
      // w1 = 7d: by construction can never hold 14 days of its own history.
      const ratio = deltaRatio(history, asOf, 7 * 24, 90 * 24);
      expect(ratio).toEqual({ established: true, value: 1 });
    });

    it('12. a window containing a raised alert excludes that period, and the baseline differs from the unexcluded one', () => {
      const history = flatHistory(90, 50, asOf);
      const spike = history.map((r, i) => (i === 45 ? { ...r, value: 500 } : r));
      const unexcluded = baselineAvg(spike, asOf, 90 * 24);

      const excluded = alertExcludedRanges(
        [{ firedAt: spike[44].at, resolvedAt: spike[46].at }],
        asOf,
      );
      const withExclusion = baselineAvg(spike, asOf, 90 * 24, excluded);

      expect(unexcluded).not.toEqual(withExclusion);
      expect(withExclusion).toEqual({ established: true, value: 50 });
    });

    it('13. exclusion that drops the remaining history below the minimum yields baseline_not_established', () => {
      const history = flatHistory(20, 50, asOf);
      const excluded = alertExcludedRanges(
        [{ firedAt: history[0].at, resolvedAt: new Date(asOf.getTime() - 10 * DAY) }],
        asOf,
      );
      expect(baselineAvg(history, asOf, 20 * 24, excluded)).toEqual({
        established: false, reason: 'baseline_not_established',
      });
    });

    it('14. an open work order excludes its whole span regardless of status wording; completed/cancelled do not exclude', () => {
      const open = openWorkOrderExcludedRanges(
        [{ status: 'in-progress', startedAt: new Date('2026-09-01'), createdAt: new Date('2026-09-01'), endedAt: null }],
        asOf,
      );
      expect(open).toEqual([{ start: new Date('2026-09-01'), end: asOf }]);

      const closed = openWorkOrderExcludedRanges(
        [{ status: 'completed', startedAt: new Date('2026-09-01'), createdAt: new Date('2026-09-01'), endedAt: new Date('2026-09-05') }],
        asOf,
      );
      expect(closed).toEqual([]);
    });
  });
});

describeDb('a named formula using a baseline operator (QCE3 composition)', () => {
  let ds: DataSource;
  let owner: DataSource;
  let service: NamedFormulaService;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    service = new NamedFormulaService(ds.getRepository(NamedFormula));
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  it('15. a named formula whose expression uses zscore publishes, inferred series/dimensionless', async () => {
    await service.create(scope, 'coolant-zscore', {
      name: 'Coolant Temperature Z-score',
      expression: 'zscore(coolant_temp, 90d)',
      inputs: [{ role: 'coolant_temp', dimension: 'degC' }],
    });
    const published = await service.publish(scope, 'coolant-zscore', 1);
    expect(published.resultKind).toBe('series');
    expect(published.resultDimension).toBe('dimensionless');
  });
});
