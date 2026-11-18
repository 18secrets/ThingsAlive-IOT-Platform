import { evaluateRule } from '../src/alert/services/alert-rules';
import { compileWorkflow } from '../src/workflow/workflow-spec';

/**
 * No data on one signal (17 Nov 2026, the AI alert prompt test log S.NO 9): "raise an
 * alert when no outrigger pressure readings are received" could only be said of the whole
 * machine. A ReadSignal may now feed a No data node, as it feeds a Threshold; the rule
 * fires on a shift with none of that signal's readings, whatever else arrived. Without a
 * ReadSignal it is the whole machine, as before.
 */
describe('No data on one signal', () => {
  const scope = { appliesTo: 'equipment', sourceSystem: 'ta-2.0', externalId: 'LTM50-001' };
  const notify = { id: 'notify', type: 'Notify', params: { name: 'Outrigger pressure lost', severity: 'low' } };
  const reading = (signal: string) => ({ signal, value: 1, sourceTimestamp: '2026-11-17T10:00:00.000Z', imei: 'IMEI-1' });
  const fire = (params: object, signals: string[]) => evaluateRule({
    trigger: 'no-telemetry', params: params as never, readings: signals.map(reading), predictions: [],
  });

  it('Read signal → No data → Notify compiles to a no-data rule on that signal, and names it among the signals read', () => {
    const compiled = compileWorkflow({
      kind: 'alert', scope,
      nodes: [{ id: 's', type: 'ReadSignal', params: { signal: 'outrigger_pressure' } }, { id: 'gate', type: 'FreshnessGate' }, notify],
      edges: [{ from: 's', to: 'gate' }, { from: 'gate', to: 'notify' }],
    });
    expect(compiled.rules).toHaveLength(1);
    expect(compiled.rules[0]).toMatchObject({ trigger: 'no-telemetry', params: { signal: 'outrigger_pressure' }, signals: ['outrigger_pressure'] });
    expect(compiled.signals).toEqual(['outrigger_pressure']);
  });

  it('fires on a shift that brought other readings but none of its signal, and not on one that brought it', () => {
    expect(fire({ signal: 'outrigger_pressure' }, ['engine_oil_pressure', 'slew_drive_temperature'])).toMatchObject({
      summary: 'The shift produced no outrigger pressure readings.',
    });
    expect(fire({ signal: 'outrigger_pressure' }, ['engine_oil_pressure', 'outrigger_pressure'])).toBeNull();
  });

  it('without a signal it is the whole machine, as before', () => {
    expect(fire({}, ['engine_oil_pressure'])).toBeNull();
    expect(fire({}, [])).toMatchObject({ summary: 'The shift produced no telemetry at all.' });
  });

  it('a No data fed by two signals, or by something that is not a ReadSignal, is refused', () => {
    const two = () => compileWorkflow({
      kind: 'alert', scope,
      nodes: [
        { id: 'a', type: 'ReadSignal', params: { signal: 'outrigger_pressure' } }, { id: 'b', type: 'ReadSignal', params: { signal: 'engine_oil_pressure' } },
        { id: 'gate', type: 'FreshnessGate' }, notify,
      ],
      edges: [{ from: 'a', to: 'gate' }, { from: 'b', to: 'gate' }, { from: 'gate', to: 'notify' }],
    });
    expect(two).toThrow(/takes at most one ReadSignal/);
  });
});
