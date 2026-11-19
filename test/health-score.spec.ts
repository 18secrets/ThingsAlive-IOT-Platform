import { Severity } from '../src/common/severity';
import { HealthInput, healthCardSentence, scoreHealth } from '../src/machine-health/health-score';

/**
 * The health score's arithmetic (D63), case by case. Each rule the decision lists is
 * one test here, and the cases that must never produce a number — no device, no logger
 * measurement, a stale or dark logger — are tested by asking for a score and getting none.
 */
describe('machine health score', () => {
  const NOW = new Date('2026-11-19T12:00:00Z');
  const base = (over: Partial<HealthInput> = {}): HealthInput => ({
    onboarded: true, link: 'healthy', linkMeasuredAt: new Date(NOW.getTime() - 3_600_000), now: NOW,
    alerts: [], predictions: [], service: 'ok', ...over,
  });

  describe('never a number without data behind it', () => {
    it.each([
      ['no device mapped', { onboarded: false }, 'not_onboarded'],
      ['no logger measurement yet', { link: null, linkMeasuredAt: null }, 'no_link_measured'],
      ['a logger measured two days ago', { linkMeasuredAt: new Date(NOW.getTime() - 49 * 3_600_000) }, 'logger_stale'],
      ['a dark logger', { link: 'dark' as const }, 'logger_dark'],
      ['a logger in an unknown state', { link: 'unknown' as const }, 'logger_unknown'],
    ])('%s: unknown, with why', (_label, over, reason) => {
      expect(scoreHealth(base(over as Partial<HealthInput>))).toMatchObject({ score: null, band: 'unknown', unknownReason: reason });
    });

    it('says nothing on the phone about a machine it cannot score', () => {
      expect(healthCardSentence(scoreHealth(base({ onboarded: false })))).toBeNull();
    });
  });

  it('scores a machine with nothing against it at 100', () => {
    expect(scoreHealth(base())).toMatchObject({ score: 100, band: 'good', deductions: [] });
  });

  it('matches the decision\'s worked example: a high alert and service due is 70', () => {
    const h = scoreHealth(base({ alerts: [{ severity: Severity.High, title: 'Coolant hot' }], service: 'due' }));
    expect(h.score).toBe(70);
    expect(h.band).toBe('watch');
    expect(h.deductions).toEqual([
      { kind: 'alert', points: 25, about: 'Coolant hot' },
      { kind: 'service', points: 5, about: 'due' },
    ]);
  });

  it('counts the worst alert in full and each further one at half', () => {
    const h = scoreHealth(base({ alerts: [
      { severity: Severity.Medium, title: 'Fuel low' },
      { severity: Severity.Critical, title: 'Oil pressure lost' },
      { severity: Severity.Low, title: 'Door open' },
    ] }));
    expect(h.deductions.map((d) => [d.about, d.points])).toEqual([['Oil pressure lost', 40], ['Fuel low', 5], ['Door open', 2.5]]);
    expect(h.score).toBe(53); // 100 - 47.5, rounded
  });

  it('takes 0.3 of the highest risk among predictions that have any confidence', () => {
    const h = scoreHealth(base({ predictions: [
      { scenario: 'coolant-drift', riskScore: 40, confidence: 'partial' },
      { scenario: 'fuel-theft', riskScore: 90, confidence: 'none' },
      { scenario: 'bearing-wear', riskScore: 60, confidence: 'full' },
    ] }));
    expect(h.deductions).toEqual([{ kind: 'prediction', points: 18, about: 'bearing-wear' }]);
    expect(h.score).toBe(82);
  });

  it('costs 15 for overdue service, and nothing for approaching or unknown', () => {
    expect(scoreHealth(base({ service: 'overdue' })).score).toBe(85);
    expect(scoreHealth(base({ service: 'approaching' })).score).toBe(100);
    expect(scoreHealth(base({ service: null })).score).toBe(100);
  });

  it('never goes below 0', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ severity: Severity.Critical, title: `A${i}` }));
    expect(scoreHealth(base({ alerts: many, service: 'overdue' })).score).toBe(0);
  });

  it('bands at 80 and 60', () => {
    const at = (risk: number) => scoreHealth(base({ predictions: [{ scenario: 's', riskScore: risk, confidence: 'full' }] }));
    expect(at(66).band).toBe('good');   // 100 - 20 = 80
    expect(at(70).band).toBe('watch');  // 100 - 21 = 79
    expect(scoreHealth(base({ alerts: [{ severity: Severity.Critical, title: 'x' }] })).band).toBe('watch'); // 60
    expect(scoreHealth(base({ alerts: [{ severity: Severity.Critical, title: 'x' }], service: 'due' })).band).toBe('act'); // 55
  });

  it('scores a partly reporting logger, and says so', () => {
    const h = scoreHealth(base({ link: 'intermittent' }));
    expect(h).toMatchObject({ score: 100, partialData: true });
    expect(healthCardSentence(h)).toBe('Health score 100 of 100, with nothing open against it. The logger is only reporting part of the time.');
  });

  it('says the score and why, from the deductions alone', () => {
    const h = scoreHealth(base({
      alerts: [{ severity: Severity.High, title: 'Coolant hot' }],
      predictions: [{ scenario: 'bearing-wear', riskScore: 20, confidence: 'full' }],
      service: 'overdue',
    }));
    expect(healthCardSentence(h)).toBe('Health score 54 of 100: one open alert, a prediction showing rising risk, service overdue.');
  });
});
