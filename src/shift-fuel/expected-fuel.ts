/**
 * Expected litres for one shift from the machine's class and its schedule alone — no
 * history (fuel test report, 3 Nov 2026: TC-FP-07, TC-FP-09; Required Design L-5).
 *
 * D50's forecast learns a shift from the same machine's last 28 days, so on its first day
 * a machine is forecast at nothing. This answers the same question from physics instead:
 *
 *   working rate (L/h) = rated_power_kw × working_load_pct/100 × bsfc_g_per_kwh ÷ 835 g/L
 *                        — or the class's nominal L/h when no BSFC is recorded
 *   working hours      = shift hours × working_share
 *   idle hours         = shift hours − working hours
 *   expected litres    = working rate × working hours + idle_fuel_per_hour × idle hours
 *
 * Every input is a figure the library recorded, the account set, or the schedule says.
 * None is assumed: a missing one blocks the answer and is named, because a default here
 * would be a litre count nobody can trace (G07). Pure arithmetic, no database and no
 * clock, so its spec can hold it to hand-worked numbers.
 */

/** Diesel, g/L. The Required Design's constant (L-4), defined once. */
export const DIESEL_DENSITY_G_PER_L = 835;

export const EXPECTED_FUEL_METHOD = 'physics-cold-start';

export interface ClassFuelFigures {
  classSlug: string;
  classVersion: number;
  className: string;
  nominalFuelPerHour: number | null;
  nominalFuelUnit: string | null;
  nominalFuelSource: string | null;
  ratedPowerKw: number | null;
  workingLoadPct: number | null;
  bsfcGPerKwh: number | null;
  bsfcSource: string | null;
  idleFuelPerHour: number | null;
  workingShare: number | null;
}

export type ExpectedFuelBlocker =
  | 'no_class' | 'no_shift_schedule' | 'working_rate_not_set' | 'nominal_unit_not_litres'
  | 'working_share_not_set' | 'idle_fuel_per_hour_not_set';

export interface ExpectedFuelInput {
  name: string;
  value: number;
  unit: string;
  /** Where the number came from, in words a person can go and check. */
  source: string;
}

export interface ExpectedFuel {
  method: typeof EXPECTED_FUEL_METHOD;
  /** Null when blocked; `blockedBy` then says on what, every missing figure at once. */
  predictedL: number | null;
  workingL: number | null;
  idleL: number | null;
  blockedBy: ExpectedFuelBlocker[];
  /** `bsfc` when power × load × BSFC gave the working rate, `nominal` when the class's L/h did. */
  workingRateFrom: 'bsfc' | 'nominal' | null;
  inputs: ExpectedFuelInput[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function classSource(f: ClassFuelFigures, column: string, citation?: string | null): string {
  const where = `library class ${f.className} (version ${f.classVersion}), ${column}`;
  return citation ? `${where}; ${citation}` : where;
}

/** The working rate in L/h, and how it was had — or null when neither path is open. */
function workingRate(f: ClassFuelFigures): { lph: number; from: 'bsfc' | 'nominal'; inputs: ExpectedFuelInput[] } | null | 'unit' {
  if (f.ratedPowerKw !== null && f.workingLoadPct !== null && f.bsfcGPerKwh !== null) {
    const lph = (f.ratedPowerKw * (f.workingLoadPct / 100) * f.bsfcGPerKwh) / DIESEL_DENSITY_G_PER_L;
    return {
      lph, from: 'bsfc',
      inputs: [
        { name: 'rated_power_kw', value: f.ratedPowerKw, unit: 'kW', source: classSource(f, 'rated_power_kw') },
        { name: 'working_load_pct', value: f.workingLoadPct, unit: '%', source: classSource(f, 'working_load_pct') },
        { name: 'bsfc_g_per_kwh', value: f.bsfcGPerKwh, unit: 'g/kWh', source: classSource(f, 'bsfc_g_per_kwh', f.bsfcSource) },
        { name: 'diesel_density', value: DIESEL_DENSITY_G_PER_L, unit: 'g/L', source: 'platform constant for diesel' },
        { name: 'working_fuel_per_hour', value: round2(lph), unit: 'L/h', source: 'computed: power × load × BSFC ÷ density' },
      ],
    };
  }
  if (f.nominalFuelPerHour !== null) {
    // The nominal is "fuel per productive hour" in its own unit; only litres per hour
    // turns into litres. Another unit is refused, never converted, as OEE refuses it.
    if (f.nominalFuelUnit !== 'L/h') return 'unit';
    return {
      lph: f.nominalFuelPerHour, from: 'nominal',
      inputs: [{
        name: 'working_fuel_per_hour', value: f.nominalFuelPerHour, unit: 'L/h',
        source: classSource(f, 'nominal_fuel_per_hour', f.nominalFuelSource ?? 'no datasheet recorded'),
      }],
    };
  }
  return null;
}

/**
 * Litres one shift of `shiftHours` should take on a machine of this class.
 *
 * `figures` null means the machine has no library class, and nothing about it is known.
 * `shiftHours` null means no shift is scheduled — the hours are the schedule's, never
 * a guessed working day.
 */
export function expectedShiftFuel(figures: ClassFuelFigures | null, shiftHours: number | null): ExpectedFuel {
  const blockedBy: ExpectedFuelBlocker[] = [];
  const inputs: ExpectedFuelInput[] = [];
  const blocked = (): ExpectedFuel => ({
    method: EXPECTED_FUEL_METHOD, predictedL: null, workingL: null, idleL: null, blockedBy,
    workingRateFrom: null, inputs,
  });

  if (!figures) {
    blockedBy.push('no_class');
    if (shiftHours === null) blockedBy.push('no_shift_schedule');
    return blocked();
  }
  if (shiftHours === null) blockedBy.push('no_shift_schedule');
  else inputs.push({ name: 'shift_hours', value: round2(shiftHours), unit: 'h', source: 'this machine\'s shift schedule' });

  const rate = workingRate(figures);
  if (rate === null) blockedBy.push('working_rate_not_set');
  else if (rate === 'unit') blockedBy.push('nominal_unit_not_litres');
  else inputs.push(...rate.inputs);

  if (figures.workingShare === null) blockedBy.push('working_share_not_set');
  else inputs.push({ name: 'working_share', value: figures.workingShare, unit: 'share of shift', source: classSource(figures, 'working_share') });

  // Idle burn is needed only when some of the shift is idle; a share of 1 has none.
  const needsIdle = figures.workingShare === null || figures.workingShare < 1;
  if (needsIdle && figures.idleFuelPerHour === null) blockedBy.push('idle_fuel_per_hour_not_set');
  else if (figures.idleFuelPerHour !== null) {
    inputs.push({ name: 'idle_fuel_per_hour', value: figures.idleFuelPerHour, unit: 'L/h', source: classSource(figures, 'idle_fuel_per_hour') });
  }

  if (blockedBy.length || shiftHours === null || rate === null || rate === 'unit' || figures.workingShare === null) {
    return blocked();
  }
  const workingHours = shiftHours * figures.workingShare;
  const idleHours = shiftHours - workingHours;
  const workingL = rate.lph * workingHours;
  const idleL = idleHours > 0 ? (figures.idleFuelPerHour ?? 0) * idleHours : 0;
  return {
    method: EXPECTED_FUEL_METHOD,
    // Each part rounded once and the total from the unrounded parts, so the parts shown
    // can differ from the total by a hundredth but the total is the arithmetic's own.
    predictedL: round2(workingL + idleL), workingL: round2(workingL), idleL: round2(idleL),
    blockedBy: [], workingRateFrom: rate.from, inputs,
  };
}
