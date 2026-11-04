import { pronounceable, speakableSummary, spokenNumber, spokenUnit } from '../src/vani/vani-speech';

/**
 * What Vani says about an alert. Text-to-speech reads exactly what it is given, so the
 * cases worth pinning are the ones where the engine's screen wording would come out
 * wrong on the phone: a snake_case key, a unit symbol, a long float.
 */
describe('vani speech', () => {
  const threshold = (over: Record<string, unknown> = {}) => ({
    summary: 'vibration_velocity breached 4.5 mm/s above on 10 of the last 10 readings; worst was 5.25 mm/s',
    evidence: {
      signal: 'vibration_velocity', unit: 'mm/s', direction: 'above', bound: 4.5, worstValue: 5.2512,
      breaches: 10, readingsInWindow: 10, lookbackReadings: 10, requiredBreaches: 6,
      at: '2026-11-04T10:10:00.000Z', imei: '359900000000101', ...over,
    },
  });

  it('says a threshold breach in words, from the evidence', () => {
    expect(speakableSummary(threshold(), 'Diesel Generator DG-01')).toBe(
      'Bearing vibration on Diesel Generator DG-01 has been above 4.5 millimeters per second '
      + 'on all of the last 10 readings, reaching 5.25 millimeters per second.',
    );
  });

  it('says how many readings when not all of them breached', () => {
    expect(speakableSummary(threshold({ breaches: 6 }), 'Diesel Generator DG-01'))
      .toContain('on 6 of the last 10 readings');
  });

  it('says a breach below a bound, for a signal it has no special name for', () => {
    expect(speakableSummary(threshold({
      signal: 'oil_pressure', unit: 'kPa', direction: 'below', bound: 150, worstValue: 92.4, breaches: 7,
    }), 'Generator 2')).toBe(
      'Oil pressure on Generator 2 has been below 150 kilopascals on 7 of the last 10 readings, reaching 92.4 kilopascals.',
    );
  });

  it('leaves out a unit it cannot pronounce rather than spelling it', () => {
    expect(spokenUnit('mm/s')).toBe('millimeters per second');
    expect(spokenUnit('degC')).toBe('degrees Celsius');
    expect(spokenUnit('furlongs/fortnight')).toBeNull();
    expect(speakableSummary(threshold({ unit: 'xyz' }), 'DG-01'))
      .toBe('Bearing vibration on DG-01 has been above 4.5 on all of the last 10 readings, reaching 5.25.');
  });

  it('never reads a long float', () => {
    expect(spokenNumber(397.4071110816279)).toBe('397.41');
    expect(spokenNumber(4.5)).toBe('4.5');
    expect(spokenNumber(150)).toBe('150');
  });

  it('keeps the engine\'s own words for any other alert, with its keys made pronounceable', () => {
    expect(speakableSummary({ summary: 'The shift produced no telemetry at all.', evidence: {} }, 'DG-01'))
      .toBe('The shift produced no telemetry at all.');
    expect(pronounceable('coolant_temp is off against what its drivers predict'))
      .toBe('coolant temp is off against what its drivers predict');
  });

  it('falls back to the engine\'s words when the evidence is not a whole threshold', () => {
    // A missing number must not become "undefined" read aloud to a customer.
    const partial = threshold({ worstValue: undefined });
    expect(speakableSummary(partial, 'DG-01')).toBe(
      'bearing vibration breached 4.5 mm/s above on 10 of the last 10 readings; worst was 5.25 mm/s',
    );
  });
});
