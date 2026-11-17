import { BadRequestException } from '@nestjs/common';

export interface CurvePointInput {
  headM: number;
  flowLpm: number;
  inputKw: number;
}

export interface CurveInput {
  /** The catalogue the table was read from, page included. Required (D58). */
  source: string;
  points: CurvePointInput[];
}

export interface CurveView {
  source: string | null;
  points: { point: number; headM: number; flowLpm: number; inputKw: number }[];
}

/** The most points a printed duty table has had; more is a paste gone wrong. */
const MAX_POINTS = 64;

/**
 * Orders the points along the curve and checks they are a duty curve: rising flow,
 * falling head. The database holds the same rule at commit (`check_duty_curve_shape`);
 * this says which points broke it. Points may arrive in either direction — a catalogue
 * prints head descending as often as ascending — and are sorted by flow, never trusted
 * to be in order.
 */
export function validateCurve(input: CurveInput): { source: string; points: CurvePointInput[] } {
  const source = typeof input?.source === 'string' ? input.source.trim() : '';
  if (!source) throw new BadRequestException('A duty curve needs a source: the catalogue and page it was read from.');
  const points = Array.isArray(input?.points) ? input.points : [];
  if (points.length === 1) throw new BadRequestException('A duty curve needs at least two points; one cannot be read between.');
  if (points.length > MAX_POINTS) throw new BadRequestException(`A duty curve has at most ${MAX_POINTS} points.`);
  for (const [i, p] of points.entries()) {
    const ok = [p?.headM, p?.flowLpm, p?.inputKw].every((v) => typeof v === 'number' && Number.isFinite(v));
    if (!ok || p.headM < 0 || p.flowLpm < 0 || !(p.inputKw > 0)) {
      throw new BadRequestException(
        `Point ${i + 1}: headM and flowLpm are numbers of at least 0, inputKw a number above 0.`,
      );
    }
  }
  const sorted = [...points].sort((a, b) => a.flowLpm - b.flowLpm);
  for (let i = 1; i < sorted.length; i += 1) {
    const [a, b] = [sorted[i - 1], sorted[i]];
    if (!(b.flowLpm > a.flowLpm) || !(b.headM < a.headM)) {
      throw new BadRequestException(
        `Points at ${a.flowLpm} and ${b.flowLpm} L/min are not a duty curve: flow must rise as head falls `
          + `(${a.headM} m then ${b.headM} m). Two points at one flow, or head rising with flow, has two answers.`,
      );
    }
  }
  return { source, points: sorted.map((p) => ({ headM: p.headM, flowLpm: p.flowLpm, inputKw: p.inputKw })) };
}

export function toCurveView(rows: { point: number; headM: number; flowLpm: number; inputKw: number; source: string }[]): CurveView {
  const ordered = [...rows].sort((a, b) => a.point - b.point);
  return {
    source: ordered[0]?.source ?? null,
    points: ordered.map((r) => ({ point: r.point, headM: r.headM, flowLpm: r.flowLpm, inputKw: r.inputKw })),
  };
}
