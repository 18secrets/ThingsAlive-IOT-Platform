import {
  Severity, atLeast, knownLegacySeverities, mapLegacySeverity, UnmappedSeverityError,
} from '../src/common/severity';

describe('severity vocabulary (P0-09 / P0-10)', () => {
  it('maps every value 2.0 claims to know', () => {
    for (const value of knownLegacySeverities()) {
      expect(Object.values(Severity)).toContain(mapLegacySeverity(value));
    }
  });

  it('round-trips its own values unchanged', () => {
    for (const s of Object.values(Severity)) {
      expect(mapLegacySeverity(s)).toBe(s);
    }
  });

  it.each([
    ['warning', Severity.Medium],
    ['WARN', Severity.Medium],
    ['  Major ', Severity.High],
    ['fatal', Severity.Critical],
    ['info', Severity.None],
    [3, Severity.High],
  ])('maps %p to %p', (input, expected) => {
    expect(mapLegacySeverity(input as any)).toBe(expected);
  });

  it.each([['catastrophic'], ['sev1'], [''], [null], [undefined], [{}]])(
    'refuses to guess at %p',
    (bad) => {
      // The point of this test: an unknown severity must stop the row, not become "low".
      expect(() => mapLegacySeverity(bad as any)).toThrow(UnmappedSeverityError);
    },
  );

  it('orders severities so thresholds can be compared', () => {
    expect(atLeast(Severity.Critical, Severity.High)).toBe(true);
    expect(atLeast(Severity.Low, Severity.High)).toBe(false);
    expect(atLeast(Severity.Medium, Severity.Medium)).toBe(true);
  });
});
