import { parsePromptToWorkflow, convertUnit } from '../frontend/src/utils/workflowParser';
import type { WorkflowScope } from '../frontend/src/utils/workflowTypes';

/**
 * The AI Assistant's prompt reader, against the tester's AI Alert Prompt Test Log
 * (17 Nov 2026, crane LTM50-001 · Liebherr LTM 1050-3.1). Each case is a prompt from the
 * log, by its S.NO, and what the log expected from it. The crane's signals and units are
 * as its class declares them.
 */
const scope: WorkflowScope = { appliesTo: 'equipment', sourceSystem: 'ta-2.0', externalId: 'LTM50-001' };
const SIGNALS = ['engine_oil_pressure', 'slew_drive_temperature', 'outrigger_pressure', 'hoist_hydraulic_pressure', 'engine_running_status'];
const UNITS = { engine_oil_pressure: 'bar', slew_drive_temperature: 'degC', outrigger_pressure: 'bar', hoist_hydraulic_pressure: 'bar', engine_running_status: 'state' };
const CRANE = 'For equipment LTM50-001 (Liebherr LTM 1050-3.1), ';

const parse = (prompt: string) => parsePromptToWorkflow(prompt, scope, SIGNALS, undefined, UNITS);
const node = (p: ReturnType<typeof parse>, type: string) => p.draft.spec.nodes.filter((n) => n.type === type);
const notify = (p: ReturnType<typeof parse>) => node(p, 'Notify')[0].params as { name: string; severity: string; description?: string };

describe('AI Assistant prompts, from the test log', () => {
  it('S.NO 2: the name, the message, and 4 of the last 7 readings, as asked', () => {
    const p = parse(`${CRANE}create an alert named “Slew Drive Overheating”. Trigger the alert when the slew drive temperature is above 80°C in at least 4 of the last 7 readings. Set the severity to Medium and notify that the slew drive is overheating and slewing operations should be reduced.`);
    expect(node(p, 'ReadSignal')[0].params).toEqual({ signal: 'slew_drive_temperature' });
    expect(node(p, 'Threshold')[0].params).toEqual({ max: 80, lookbackReadings: 7, requiredBreaches: 4 });
    expect(notify(p)).toEqual({
      name: 'Slew Drive Overheating', severity: 'medium',
      description: 'The slew drive is overheating and slewing operations should be reduced.',
    });
    expect(p.draft.name).toBe('Slew Drive Overheating');
  });

  it('S.NO 4: a severity word inside the name does not override "Set the severity to Critical"', () => {
    const p = parse(`${CRANE}create an alert named "Low Outrigger Pressure – Loss of Crane Support". Monitor the outrigger pressure signal. Trigger the alert when the outrigger pressure is below 40 bar in at least 4 of the last 8 readings. Set the severity to Critical and notify that lifting operations should be stopped and inspected.`);
    expect(notify(p).severity).toBe('critical');
    expect(notify(p).name).toBe('Low Outrigger Pressure – Loss of Crane Support');
    expect(node(p, 'Threshold')[0].params).toEqual({ min: 40, lookbackReadings: 8, requiredBreaches: 4 });
    expect(node(p, 'ReadSignal')).toHaveLength(1);
  });

  it('S.NO 6: either condition, each with its own 5 of 8', () => {
    const p = parse(`${CRANE}create an alert named "Engine or Slew Drive Protection". Trigger the alert if either of these conditions is true: engine oil pressure is below 2 bar in at least 5 of the last 8 readings, or slew drive temperature is above 75°C in at least 5 of the last 8 readings. Set the severity to High and notify that the crane must stop operating and be inspected.`);
    expect(node(p, 'AnyOf')).toHaveLength(1);
    expect(node(p, 'Threshold').map((n) => n.params)).toEqual([
      { min: 2, lookbackReadings: 8, requiredBreaches: 5 }, { max: 75, lookbackReadings: 8, requiredBreaches: 5 },
    ]);
  });

  it('S.NO 7: both conditions, each with its own 3 of 6', () => {
    const p = parse(`${CRANE}create an alert named "Hoist Hydraulic Overload". Trigger the alert only when both conditions are true at the same time: hoist hydraulic pressure is below 180 bar in at least 3 of the last 6 readings, and slew drive temperature is above 75°C in at least 3 of the last 6 readings. Set the severity to Medium and notify that the hoist hydraulic system is under stress and should be inspected.`);
    expect(node(p, 'AllOf')).toHaveLength(1);
    expect(node(p, 'ReadSignal').map((n) => (n.params as { signal: string }).signal)).toEqual(['hoist_hydraulic_pressure', 'slew_drive_temperature']);
    expect(node(p, 'Threshold').map((n) => n.params)).toEqual([
      { min: 180, lookbackReadings: 6, requiredBreaches: 3 }, { max: 75, lookbackReadings: 6, requiredBreaches: 3 },
    ]);
    expect(p.contradictions).toEqual([]);
  });

  it('S.NO 8: a short prompt still builds as before, with the unit in its name and no raw prompt as the message', () => {
    const p = parse(`${CRANE}raise an alert when the slew drive temperature goes above 85°C. Set the severity to High.`);
    expect(node(p, 'Threshold')[0].params).toEqual({ max: 85 });
    expect(notify(p)).toEqual({ name: 'Slew drive temperature above 85 °C', severity: 'high', description: 'Slew drive temperature above 85 °C.' });
  });

  it('S.NO 9: "no outrigger pressure readings" is No data on outrigger pressure: Read signal → No data → Notify', () => {
    const p = parse(`${CRANE}create an alert named "Outrigger Pressure Telemetry Lost". Raise an alert when no outrigger pressure readings are received from the machine. Set the severity to Low and notify that outrigger pressure data is missing and the sensor connection should be checked.`);
    expect(p.conditions).toBe(1);
    expect(node(p, 'FreshnessGate')).toHaveLength(1);
    expect(node(p, 'ReadSignal').map((n) => n.params)).toEqual([{ signal: 'outrigger_pressure' }]);
    expect(p.draft.spec.edges).toEqual(expect.arrayContaining([{ from: 'no-data-signal', to: 'no-data' }, { from: 'no-data', to: 'notify' }]));
    expect(node(p, 'Threshold')).toHaveLength(0);
    expect(notify(p)).toMatchObject({ name: 'Outrigger Pressure Telemetry Lost', severity: 'low' });
    expect(p.notes).toEqual([]);
  });

  it('no data on a signal the machine does not have watches the whole machine, and says so', () => {
    const p = parse(`${CRANE}raise an alert when no wind speed readings are received.`);
    expect(node(p, 'FreshnessGate')).toHaveLength(1);
    expect(node(p, 'ReadSignal')).toHaveLength(0);
    expect(p.notes).toEqual([{ key: 'noDataWholeMachine', values: { signal: 'wind speed' } }]);
  });

  it('S.NO 17: a phrase two signals fit equally is chosen, and the other is named', () => {
    const p = parsePromptToWorkflow('Raise an alert when the hydraulic pressure drops below 160 bar.', scope,
      ['hoist_hydraulic_pressure', 'outrigger_hydraulic_pressure'], undefined, {});
    expect(node(p, 'ReadSignal')[0].params).toEqual({ signal: 'hoist_hydraulic_pressure' });
    expect(p.notes).toEqual([{ key: 'ambiguousSignal', values: { phrase: 'hydraulic pressure', chosen: 'hoist hydraulic pressure', others: 'outrigger hydraulic pressure' } }]);
  });

  it('S.NO 17 as the tester ran it: one signal fits, so nothing is asked', () => {
    expect(parse(`${CRANE}raise an alert when the hydraulic pressure drops below 160 bar. Set the severity to High.`).notes).toEqual([]);
  });

  it('S.NO 10: no signal made of filler words; both bounds on outrigger pressure, refused as impossible', () => {
    const p = parse(`${CRANE}create an alert named "Outrigger Pressure Conflict". Trigger the alert only when the outrigger pressure is above 100 bar and also below 40 bar. Set the severity to High.`);
    expect(p.unmatched).toEqual([]);
    expect(node(p, 'ReadSignal').map((n) => (n.params as { signal: string }).signal)).toEqual(['outrigger_pressure', 'outrigger_pressure']);
    expect(p.contradictions).toEqual([{ signal: 'outrigger pressure', above: 100, below: 40 }]);
  });

  it('S.NO 11: "greater than 100 and less than 40 at the same time" is refused as impossible', () => {
    const p = parse(`${CRANE}create an alert named "Outrigger Pressure Conflict". Raise an alert only when outrigger pressure is greater than 100 and outrigger pressure is less than 40 at the same time. Set the severity to High.`);
    expect(p.contradictions).toEqual([{ signal: 'outrigger pressure', above: 100, below: 40 }]);
  });

  it('a band is not a contradiction: above 40 and below 100 can both be true', () => {
    const p = parse(`${CRANE}raise an alert when the outrigger pressure is above 40 bar and below 100 bar.`);
    expect(p.contradictions).toEqual([]);
  });

  it('S.NO 12: "prediction severity is high" is a Prediction severity alert, at high or above', () => {
    const p = parse(`${CRANE}create an alert named "Predicted Failure Risk". Raise an alert when the prediction severity for this machine is high. Set the severity to High and notify that a failure is predicted and maintenance should be planned.`);
    expect(node(p, 'PredictionSeverity').map((n) => n.params)).toEqual([{ atLeast: 'high' }]);
    expect(notify(p)).toMatchObject({ name: 'Predicted Failure Risk', severity: 'high', description: 'A failure is predicted and maintenance should be planned.' });
  });

  it('S.NO 13: the editor\'s own field names set the readings counts', () => {
    const p = parse(`${CRANE}raise an alert when the engine oil pressure is below 2 bar. Set Readings Considered to 8 and Readings That Must Breach to 4. Set the severity to High.`);
    expect(node(p, 'Threshold')[0].params).toEqual({ min: 2, lookbackReadings: 8, requiredBreaches: 4 });
  });

  it('S.NO 16: 29 psi is converted to the signal\'s bar, and says so', () => {
    const p = parse(`${CRANE}raise an alert when the engine oil pressure goes below 29 psi. Set the severity to High.`);
    expect(node(p, 'Threshold')[0].params).toEqual({ min: 2 });
    expect(p.notes).toEqual([{ key: 'converted', values: { from: '29 psi', to: '2 bar', signal: 'engine oil pressure' } }]);
    expect(notify(p).name).toBe('Engine oil pressure below 2 bar');
  });

  it('a unit of another kind is not converted, and is named as a mismatch', () => {
    const p = parse(`${CRANE}raise an alert when the engine oil pressure goes below 3 V.`);
    expect(p.notes).toEqual([{ key: 'unitMismatch', values: { unit: 'V', signalUnit: 'bar', signal: 'engine oil pressure' } }]);
  });

  it('S.NO 18 and 20: "goes over 90" is above 90, with or without the unit, and "mark it critical" is the severity', () => {
    for (const prompt of [
      'Let me know if the slew drive temperature goes over 90 degrees on LTM50-001. This is serious, mark it critical.',
      'Let me know if the slew drive temperature goes over 90°C on LTM50-001. This is serious, mark it critical.',
    ]) {
      const p = parse(prompt);
      expect(node(p, 'ReadSignal')[0].params).toEqual({ signal: 'slew_drive_temperature' });
      expect(node(p, 'Threshold')[0].params).toEqual({ max: 90 });
      expect(notify(p).severity).toBe('critical');
    }
  });

  it('S.NO 21 and 22 keep working: "exceeds" and "drops under"', () => {
    expect(node(parse(`${CRANE}raise an alert when the slew drive temperature exceeds 95°C. Set the severity to High.`), 'Threshold')[0].params).toEqual({ max: 95 });
    expect(node(parse(`${CRANE}raise an alert when the outrigger pressure drops under 45 bar. Set the severity to Critical.`), 'Threshold')[0].params).toEqual({ min: 45 });
  });

  it('a duration is not a threshold: "for more than 3 minutes" adds no condition', () => {
    const p = parse('Warn me when slew drive temperature is above 80 C for more than 3 minutes');
    expect(node(p, 'Threshold').map((n) => n.params)).toEqual([{ max: 80 }]);
  });

  it('more breaches than readings is dropped and named, not saved as a rule that can never fire', () => {
    const p = parse(`${CRANE}raise an alert when the slew drive temperature is above 80°C in at least 7 of the last 5 readings.`);
    expect(node(p, 'Threshold')[0].params).toEqual({ max: 80, lookbackReadings: 5 });
    expect(p.notes).toEqual([{ key: 'breachesOverLookback', values: { breaches: 7, lookback: 5 } }]);
  });

  it('converts the units the log used both ways', () => {
    expect(convertUnit(29, 'psi', 'bar')).toBe(2);
    expect(convertUnit(212, 'degf', 'degc')).toBe(100);
    expect(convertUnit(2, 'bar', 'kpa')).toBe(200);
    expect(convertUnit(2, 'bar', 'v')).toBeNull();
  });
});
