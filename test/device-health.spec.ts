import {
  BUFFERING_LAG_SECONDS,
  DROPOUT_SECONDS,
  LinkInput,
  assessLink,
} from '../src/device-health/services/link-health';
import {
  CSQ_UNKNOWN,
  bandFor,
  inferSignalScale,
  summariseSignal,
} from '../src/device-health/services/signal-scale';
import { SIGNALS } from '../src/common/signals';

/**
 * Diagnosing a thin window (task P4-08).
 *
 * The tests are organised around the thing that makes this worth building: four faults
 * that produce identical coverage numbers and want four different people. Each state
 * has a test that removes exactly the evidence for it and checks the verdict moves.
 */

const START = new Date('2026-09-14T00:00:00Z');
const end = (hours: number) => new Date(START.getTime() + hours * 3600_000);

const at = (minute: number, signal: string, value: number) => ({
  signal, value, unit: null,
  sourceTimestamp: new Date(START.getTime() + minute * 60_000).toISOString(),
});

/** A device reporting `signals` once a minute for `minutes`. */
const steady = (minutes: number, signals: string[], value = 1, fromMinute = 0) =>
  Array.from({ length: minutes }, (_, i) =>
    signals.map((s) => at(fromMinute + i, s, value))).flat();

const input = (over: Partial<LinkInput> = {}): LinkInput => ({
  windowStart: START,
  windowEnd: end(8),
  readings: steady(480, [SIGNALS.engineRunningStatus, SIGNALS.gsmSignalStrength], 1),
  expectedSignals: [SIGNALS.engineRunningStatus, SIGNALS.gsmSignalStrength],
  arrival: { count: 960, medianLagSeconds: 20, maxLagSeconds: 60 },
  ...over,
});

describe('inferSignalScale', () => {
  it('reads negative values as dBm', () => {
    expect(inferSignalScale([-95, -87, -101]).scale).toBe('dbm');
  });

  it('reads anything above CSQ\'s ceiling as percent', () => {
    expect(inferSignalScale([40, 65, 80]).scale).toBe('percent');
  });

  it('refuses a range that is a valid CSQ and a valid percent at once', () => {
    // 0..31 is both, and the numbers cannot say which. A fleet at CSQ 20 is healthy;
    // the same values as percent are poor. Choosing would either invent a fleet-wide
    // fault or hide a real one.
    const i = inferSignalScale([18, 22, 20]);
    expect(i.scale).toBeNull();
    expect(i.reason).toBe('ambiguous');
  });

  it('refuses values that are off every scale', () => {
    // Not a weak signal — a broken mapping, and banding it would report an unusable
    // link where the real fault is a wrong column.
    expect(inferSignalScale([-400, -380]).reason).toBe('out-of-range');
    expect(inferSignalScale([4000]).reason).toBe('out-of-range');
  });

  it('drops the modem\'s own "cannot measure" sentinel', () => {
    // CSQ 99 is not a strength of 99. Including it would turn an unmeasurable link
    // into the best one in the fleet.
    const i = inferSignalScale([CSQ_UNKNOWN, CSQ_UNKNOWN]);
    expect(i.scale).toBeNull();
    expect(i.reason).toBe('no-values');
    expect(inferSignalScale([20, CSQ_UNKNOWN]).max).toBe(20);
  });
});

describe('bandFor', () => {
  it('bands dBm the right way round', () => {
    // The failure this exists to prevent: -60 is excellent, not catastrophic.
    expect(bandFor(-60, 'dbm')).toBe('excellent');
    expect(bandFor(-80, 'dbm')).toBe('good');
    expect(bandFor(-95, 'dbm')).toBe('fair');
    expect(bandFor(-110, 'dbm')).toBe('poor');
  });

  it('bands CSQ and percent', () => {
    expect(bandFor(25, 'csq')).toBe('excellent');
    expect(bandFor(5, 'csq')).toBe('poor');
    expect(bandFor(80, 'percent')).toBe('excellent');
    expect(bandFor(10, 'percent')).toBe('poor');
  });

  it('does not band a dBm reading against CSQ thresholds', () => {
    // Banding -95 as CSQ would call every device in the fleet catastrophic for ever,
    // and the alert would be muted within a week.
    expect(bandFor(-95, 'dbm')).toBe('fair');
    expect(bandFor(-95, 'csq')).toBe('poor');
  });
});

describe('summariseSignal', () => {
  it('reports the typical value and the worst moment', () => {
    // A link is judged by its bad moments: a median of -80 with a dip to -108 is a
    // link that drops under load, and the median alone would call it good.
    const s = summariseSignal([-80, -79, -108, -81]);
    expect(s.scale).toBe('dbm');
    expect(s.band).toBe('good');
    expect(s.worst).toBe(-108);
    expect(s.worstBand).toBe('poor');
  });

  it('says nothing when the scale is ambiguous', () => {
    const s = summariseSignal([20, 22]);
    expect(s.band).toBeNull();
    expect(s.scaleReason).toBe('ambiguous');
    // The samples are still counted, so a screen can say it looked and could not tell.
    expect(s.samples).toBe(2);
  });

  it('counts the unmeasurable samples separately', () => {
    const s = summariseSignal([-90, CSQ_UNKNOWN, -92]);
    expect(s.unknownSamples).toBe(1);
    expect(s.samples).toBe(2);
  });
});

describe('assessLink', () => {
  it('calls a steady, on-time device healthy', () => {
    const h = assessLink(input({
      readings: [...steady(480, [SIGNALS.engineRunningStatus]), ...steady(480, [SIGNALS.gsmSignalStrength], -75)],
    }));
    expect(h.state).toBe('healthy');
    expect(h.missingSignals).toEqual([]);
  });

  it('calls a silent device dark, and says nobody is holding its data', () => {
    const h = assessLink(input({ readings: [], arrival: { count: 0, medianLagSeconds: 0, maxLagSeconds: 0 } }));
    expect(h.state).toBe('dark');
    expect(h.longestGapSeconds).toBe(8 * 3600);
  });

  it('does not call a device dark when the platform is holding its readings', () => {
    // Silence here with arrivals upstream is our own sync lag, not a failed logger,
    // and sending somebody to a yard for it would be our mistake rather than theirs.
    const h = assessLink(input({
      readings: [], arrival: { count: 400, medianLagSeconds: 30, maxLagSeconds: 90 },
    }));
    expect(h.state).toBe('buffering');
    expect(h.detail).toMatch(/not been ingested/);
  });

  it('separates dead sensors from a bad link', () => {
    // The device is up and its radio is fine. Reporting this as a connectivity fault
    // sends a network engineer to a machine whose radio works.
    const h = assessLink(input({
      readings: steady(480, [SIGNALS.gsmSignalStrength], -70),
      expectedSignals: [
        SIGNALS.gsmSignalStrength, SIGNALS.engineRunningStatus,
        SIGNALS.coolantTemperature, SIGNALS.oilPressure, SIGNALS.fuelLevel,
      ],
    }));
    expect(h.state).toBe('partial');
    expect(h.missingSignals).toContain(SIGNALS.coolantTemperature);
    expect(h.detail).toMatch(/1 of 5 mapped signals/);
  });

  it('calls a dropping link intermittent', () => {
    // Four hours of reporting, then a two-hour hole, then more. The logger had nothing
    // to hold, so those readings are gone rather than late.
    const h = assessLink(input({
      readings: [
        ...steady(240, [SIGNALS.engineRunningStatus]),
        ...steady(120, [SIGNALS.engineRunningStatus], 1, 360),
      ],
      expectedSignals: [SIGNALS.engineRunningStatus],
    }));
    expect(h.state).toBe('intermittent');
    expect(h.longestGapSeconds).toBeGreaterThanOrEqual(DROPOUT_SECONDS);
  });

  it('calls a lagging but complete link buffering, not broken', () => {
    // The distinction that decides whether anybody gets in a van. This data is
    // complete and late; the window is re-scored when the backlog lands.
    const h = assessLink(input({
      arrival: { count: 960, medianLagSeconds: BUFFERING_LAG_SECONDS, maxLagSeconds: 7200 },
    }));
    expect(h.state).toBe('buffering');
    expect(h.detail).toMatch(/Complete, and late/);
  });

  it('prefers a dropout to a lag when both are true', () => {
    // A dropout costs the customer a prediction and a lag does not, so the verdict
    // names the one somebody has to act on.
    const h = assessLink(input({
      readings: [
        ...steady(240, [SIGNALS.engineRunningStatus]),
        ...steady(120, [SIGNALS.engineRunningStatus], 1, 360),
      ],
      expectedSignals: [SIGNALS.engineRunningStatus],
      arrival: { count: 400, medianLagSeconds: 3600, maxLagSeconds: 7200 },
    }));
    expect(h.state).toBe('intermittent');
  });

  it('flags a link running at the edge before it fails', () => {
    const h = assessLink(input({
      readings: [
        ...steady(479, [SIGNALS.gsmSignalStrength], -75),
        at(479, SIGNALS.gsmSignalStrength, -104),
      ],
      expectedSignals: [SIGNALS.gsmSignalStrength],
    }));
    expect(h.state).toBe('weak-signal');
    expect(h.signal.band).toBe('good');
    expect(h.signal.worstBand).toBe('poor');
  });

  it('does not call a link weak when it cannot read the scale', () => {
    // Ambiguous values must not produce a verdict. Guessing CSQ-as-percent would put
    // a healthy fleet permanently in the weak column.
    const h = assessLink(input({
      readings: [...steady(480, [SIGNALS.engineRunningStatus]), ...steady(480, [SIGNALS.gsmSignalStrength], 20)],
    }));
    expect(h.state).toBe('healthy');
    expect(h.signal.scaleReason).toBe('ambiguous');
  });

  it('counts a silence at the end of the window, not only between readings', () => {
    // A device that went quiet an hour before the shift ended has an hour-long gap.
    // Measuring only between readings would score it perfect at the exact moment
    // somebody wants to be told.
    const h = assessLink(input({
      readings: steady(300, [SIGNALS.engineRunningStatus]),
      expectedSignals: [SIGNALS.engineRunningStatus],
      arrival: null,
    }));
    expect(h.longestGapSeconds).toBeGreaterThanOrEqual(3 * 3600 - 60);
    expect(h.state).toBe('intermittent');
  });

  it('works with no arrival data at all', () => {
    // The upstream connection can be missing; that is a fact about our read, not about
    // the device, and it must not turn into a verdict about the device.
    const h = assessLink(input({ arrival: null }));
    expect(h.state).toBe('healthy');
    expect(h.medianLagSeconds).toBeNull();
  });

  it('ignores readings outside the window', () => {
    const h = assessLink(input({
      readings: [{
        signal: SIGNALS.engineRunningStatus, value: 1, unit: null,
        sourceTimestamp: new Date(START.getTime() - 3600_000).toISOString(),
      }],
      arrival: { count: 0, medianLagSeconds: 0, maxLagSeconds: 0 },
    }));
    expect(h.samples).toBe(0);
    expect(h.state).toBe('dark');
  });
});
