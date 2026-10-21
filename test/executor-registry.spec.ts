import { EXECUTOR_REGISTRY, ExecContext } from '../src/catalog/formula/executor-registry';
import { OPERATOR_REGISTRY } from '../src/catalog/formula/operator-registry';
import { Reading } from '../src/catalog/formula/baseline-operators';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const series = (points: [number, number][], base: Date): Reading[] =>
  points.map(([hoursAgo, value]) => ({ at: new Date(base.getTime() - hoursAgo * HOUR), value }));

const ctx = (from: Date, to: Date): ExecContext => ({ windowFrom: from, windowTo: to, history: [], excludedRanges: [] });

/**
 * The executor registry (task QCE2) — one executor per operator in the
 * compiler's `OPERATOR_REGISTRY`, never `eval`. Same pattern QGRANT0's
 * inventory used: the key-set match is asserted, not assumed, so an operator
 * added to one table without the other fails the build.
 */
describe('executor registry', () => {
  it('1. has exactly one executor per compiler operator — no more, no fewer', () => {
    expect(Object.keys(EXECUTOR_REGISTRY).sort()).toEqual(Object.keys(OPERATOR_REGISTRY).sort());
  });

  describe('aggregates', () => {
    const NOW = new Date('2026-09-22T12:00:00.000Z');
    const from = new Date(NOW.getTime() - 2 * HOUR);

    it('2. avg/min/max/sum/count over the window, ignoring readings outside it', () => {
      const s = series([[3, 10], [1.5, 20], [0.5, 30]], NOW); // first is outside [from, NOW]
      expect(EXECUTOR_REGISTRY.avg.run([s], [], [], ctx(from, NOW))).toEqual({ ok: true, value: 25 });
      expect(EXECUTOR_REGISTRY.min.run([s], [], [], ctx(from, NOW))).toEqual({ ok: true, value: 20 });
      expect(EXECUTOR_REGISTRY.max.run([s], [], [], ctx(from, NOW))).toEqual({ ok: true, value: 30 });
      expect(EXECUTOR_REGISTRY.sum.run([s], [], [], ctx(from, NOW))).toEqual({ ok: true, value: 50 });
      expect(EXECUTOR_REGISTRY.count.run([s], [], [], ctx(from, NOW))).toEqual({ ok: true, value: 2 });
    });

    it('3. an empty window is no_readings, not 0 or NaN', () => {
      expect(EXECUTOR_REGISTRY.avg.run([[]], [], [], ctx(from, NOW))).toEqual({ ok: false, reason: 'no_readings' });
    });

    it('4. first/last/delta read window order, not insertion order', () => {
      const s = series([[0.5, 30], [1.5, 20]], NOW); // unsorted: 0.5h ago then 1.5h ago
      expect(EXECUTOR_REGISTRY.first.run([s], [], [], ctx(from, NOW))).toEqual({ ok: true, value: 30 });
      expect(EXECUTOR_REGISTRY.last.run([s], [], [], ctx(from, NOW))).toEqual({ ok: true, value: 20 });
    });

    it('5. rate divides by zero elapsed hours as undefined_result, not Infinity', () => {
      const atOnce = [{ at: NOW, value: 1 }, { at: NOW, value: 2 }];
      expect(EXECUTOR_REGISTRY.rate.run([atOnce], [], [], ctx(from, NOW))).toEqual({ ok: false, reason: 'undefined_result' });
    });

    it('6. fraction_within counts readings inside [lo, hi]', () => {
      const s = series([[1, 5], [0.5, 15], [0.2, 25]], NOW);
      expect(EXECUTOR_REGISTRY.fraction_within.run([s], [10, 20], [], ctx(from, NOW)))
        .toEqual({ ok: true, value: 1 / 3 });
    });
  });

  describe('baseline family (QCE4 pass-through)', () => {
    const NOW = new Date('2026-09-22T00:00:00.000Z');
    const flat = Array.from({ length: 20 }, (_, i) => ({
      at: new Date(NOW.getTime() - (20 - i) * DAY), value: 50,
    }));

    it('7. baseline_sd of a constant series is 0, so zscore divides by zero → undefined_result, '
      + 'not an anomaly — a perfectly steady signal is the common case on a healthy machine', () => {
      const withCurrent = [...flat, { at: NOW, value: 50 }];
      const sd = EXECUTOR_REGISTRY.baseline_sd.run([withCurrent], [], [20 * 24], ctx(NOW, NOW));
      expect(sd).toEqual({ ok: true, value: 0 });
      const z = EXECUTOR_REGISTRY.zscore.run([withCurrent], [], [20 * 24], ctx(NOW, NOW));
      expect(z).toEqual({ ok: false, reason: 'undefined_result' });
    });

    it('8. fewer than 14 days of history is baseline_not_established, pass-through from QCE4', () => {
      const short = flat.slice(-10); // 10 days
      expect(EXECUTOR_REGISTRY.baseline_avg.run([short], [], [20 * 24], ctx(NOW, NOW)))
        .toEqual({ ok: false, reason: 'baseline_not_established' });
    });

    it('9. delta_ratio of two equal legs is 1', () => {
      expect(EXECUTOR_REGISTRY.delta_ratio.run([flat], [], [7 * 24, 20 * 24], ctx(NOW, NOW)))
        .toEqual({ ok: true, value: 1 });
    });
  });
});
