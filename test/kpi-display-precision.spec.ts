import { RequestScope } from '../src/auth/types/request-scope';
import { KpiController } from '../src/kpi/kpi.controller';
import { displayDecimals, presentEnvelope, roundTo } from '../src/kpi/kpi-presentation';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { KpiEnvelope } from '../src/kpi/types';

const envelope = (formulaKey: string, value: KpiEnvelope['value'], resultKind: KpiEnvelope['resultKind'] = 'scalar'): KpiEnvelope => ({
  formulaKey, value, unit: 'degC', resultKind, window: { from: '2026-10-25T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' },
  readiness: 'ready', coverage: { expected: 288, actual: 143, ratio: 0.4965277777777778 },
});

/**
 * KPI values leave the API at the formula's display precision, never past two decimals
 * (dev testing: "62.48535053145343 degC"). Rounded at the edge, so nothing computed
 * from a KPI inside the platform inherits the rounding.
 */
describe('KPI display precision', () => {
  it('a formula\'s number:N is its decimals, capped at two; anything else is two', () => {
    expect([displayDecimals('number:0'), displayDecimals('number:1'), displayDecimals('number:2'), displayDecimals('number:6')])
      .toEqual([0, 1, 2, 2]);
    expect([displayDecimals(undefined), displayDecimals(null), displayDecimals('percent'), displayDecimals('')]).toEqual([2, 2, 2, 2]);
  });

  it('rounds half away from zero, and never shows -0', () => {
    expect([roundTo(0.465, 2), roundTo(-0.465, 2), roundTo(1.005, 2), roundTo(-0.004, 2)]).toEqual([0.47, -0.47, 1.01, 0]);
    expect(Object.is(roundTo(-0.004, 2), 0)).toBe(true);
    // Numbers JavaScript prints in exponent form, and the non-finite, come through sane.
    expect([roundTo(1e-7, 2), roundTo(1.23e21, 2), roundTo(Infinity, 2)]).toEqual([0, 1.23e21, Infinity]);
  });

  it('a scalar and every point of a series are rounded; a gap stays a gap, and coverage is untouched', () => {
    expect(presentEnvelope(envelope('avg_hydraulic_temp', 62.48535053145343), 'number:1').value).toBe(62.5);
    const series = presentEnvelope(envelope('coolant_trace', [
      { t: '2026-10-25T01:00:00.000Z', v: 84.27840346806059 }, { t: '2026-10-25T02:00:00.000Z', v: null },
    ], 'series'), 'number:2');
    expect(series.value).toEqual([{ t: '2026-10-25T01:00:00.000Z', v: 84.28 }, { t: '2026-10-25T02:00:00.000Z', v: null }]);
    expect(series.coverage.ratio).toBe(0.4965277777777778);
    expect(presentEnvelope(envelope('avg_fuel_level', null), 'number:1').value).toBeNull();
  });

  it('presenting does not change the envelope it was given', () => {
    const e = envelope('avg_oil_pressure', 391.06884837938856);
    presentEnvelope(e, 'number:1');
    expect(e.value).toBe(391.06884837938856);
  });

  describe('the KPI routes', () => {
    const scope = { tenantId: 'acme' } as RequestScope;
    const evaluator = {
      evaluateAll: async () => [
        envelope('avg_hydraulic_temp', 62.48535053145343),
        envelope('coolant_vs_baseline', 0.4618131869686849),
        envelope('no_format', 58.899171107412776),
      ],
      evaluateOne: async () => envelope('avg_oil_pressure', 391.06884837938856),
      displayFormats: async () => new Map([
        ['avg_hydraulic_temp', 'number:1'], ['coolant_vs_baseline', 'number:2'], ['avg_oil_pressure', 'number:1'],
      ]),
    } as unknown as KpiEvaluatorService;
    const controller = new KpiController(evaluator);

    it('the list shows each KPI at its own precision, at most two decimals', async () => {
      const list = await controller.listKpis(scope, 'ta-2.0', 'EX-01');
      expect(list.map((e) => e.value)).toEqual([62.5, 0.46, 58.9]);
    });

    it('one KPI, the same', async () => {
      expect((await controller.getKpi(scope, 'ta-2.0', 'EX-01', 'avg_oil_pressure', {})).value).toBe(391.1);
    });
  });
});
