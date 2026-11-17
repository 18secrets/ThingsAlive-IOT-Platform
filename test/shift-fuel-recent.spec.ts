import {
  forecastShift, forecastShiftRecent, RECENT_METHOD, SHIFT_FUEL_METHOD, shiftFuelMethodFrom, ShiftObservation,
} from '../src/shift-fuel/shift-fuel-forecast';

/**
 * D51: the second shift fuel method. Same-shift average with alpha 0.6, and nothing when
 * the machine stood idle on both of the latest shifts the forecast can see.
 */
describe('D51: recent-0.6-28d', () => {
  const obs = (sdate: string, shift: 1 | 2, fuelL: number | null): ShiftObservation => ({ sdate, shift, fuelL });
  const target = { sdate: '2026-10-20', shift: 1 as const };

  it('leans harder on the newest shift than ewma-0.5-28d does', () => {
    const history = [obs('2026-10-18', 1, 100), obs('2026-10-19', 1, 200)];
    expect(forecastShiftRecent(history, target)).toEqual({ predictedL: 160, inputsThrough: '2026-10-19' });
    expect(forecastShift(history, target).predictedL).toBe(150);
  });

  it('forecasts nothing when its own shift and the latest shift were both idle', () => {
    const history = [obs('2026-10-18', 1, 120), obs('2026-10-19', 1, 0), obs('2026-10-19', 2, 0)];
    expect(forecastShiftRecent(history, target)).toEqual({ predictedL: 0, inputsThrough: '2026-10-19' });
  });

  it('still forecasts when the machine ran on the shift that came last', () => {
    const history = [obs('2026-10-18', 1, 120), obs('2026-10-19', 1, 0), obs('2026-10-19', 2, 40)];
    expect(forecastShiftRecent(history, target).predictedL).toBe(48);
  });

  it('looks at nothing from the target\'s own day: tonight\'s forecast is issued before today\'s day shift ends', () => {
    const night = { sdate: '2026-10-20', shift: 2 as const };
    // Today's day shift idle, but it is on the target's own date, so it is not seen.
    const history = [obs('2026-10-19', 2, 0), obs('2026-10-19', 1, 50), obs('2026-10-20', 1, 0)];
    // Latest seen is 19 Oct night (0), and the same-shift latest is that one too: gated.
    expect(forecastShiftRecent(history, night).predictedL).toBe(0);
    const ran = [obs('2026-10-18', 2, 30), obs('2026-10-19', 1, 0), obs('2026-10-19', 2, 60), obs('2026-10-20', 1, 0)];
    expect(forecastShiftRecent(ran, night)).toEqual({ predictedL: 48, inputsThrough: '2026-10-19' });
  });

  it('skips a row with no figure rather than reading it as idle', () => {
    const history = [obs('2026-10-18', 1, 100), obs('2026-10-19', 1, null), obs('2026-10-19', 2, null)];
    expect(forecastShiftRecent(history, target)).toEqual({ predictedL: 100, inputsThrough: '2026-10-18' });
  });

  it('is chosen by SHIFT_FUEL_FORECAST_METHOD, defaults to ewma-0.5-28d, and refuses an unknown name', () => {
    expect(shiftFuelMethodFrom({})).toBe(SHIFT_FUEL_METHOD);
    expect(shiftFuelMethodFrom({ SHIFT_FUEL_FORECAST_METHOD: ' recent-0.6-28d ' })).toBe(RECENT_METHOD);
    expect(() => shiftFuelMethodFrom({ SHIFT_FUEL_FORECAST_METHOD: 'ewma-0.7' })).toThrow(/is not one of/);
  });
});
