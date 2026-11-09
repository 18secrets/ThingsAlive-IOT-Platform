import { BadRequestException } from '@nestjs/common';
import { OPERATIONAL_PARAMETERS } from '../../parameters/parameter-catalog';

export interface RatingInput {
  name: string;
  value: number;
  /** Optional: when given it must be the rating's own unit. Nothing is converted. */
  unit?: string | null;
  source: string;
}

export interface RatingView {
  name: string;
  value: number;
  /** The rating's own unit, from the catalog: what `value` is measured in. */
  unit: string | null;
  source: string;
  updatedBy: string;
  updatedAt: Date;
}

/** The D56 ratings: the only parameters a model may carry. */
const RATINGS = new Map(
  OPERATIONAL_PARAMETERS.filter((p) => p.compilesWithUnit).map((p) => [p.name, p.unit]),
);

export function ratingUnit(name: string): string | null {
  return RATINGS.get(name) ?? null;
}

/**
 * The service's statement of what the database also refuses (unknown name, blank
 * source, a value that is not a finite number), said with the rating's name instead of
 * a constraint's, plus the two things the database cannot see: a unit that disagrees
 * with the rating's, and a name given twice in one request.
 */
export function validateRatings(ratings: RatingInput[]): RatingInput[] {
  if (!Array.isArray(ratings)) throw new BadRequestException('ratings must be a list.');
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const r of ratings) {
    const name = typeof r?.name === 'string' ? r.name.trim() : '';
    if (!RATINGS.has(name)) {
      problems.push(`"${name}" is not a rating a model can carry. Ratings: ${[...RATINGS.keys()].join(', ')}.`);
      continue;
    }
    if (seen.has(name)) problems.push(`"${name}" is given twice.`);
    seen.add(name);
    if (typeof r.value !== 'number' || !Number.isFinite(r.value)) {
      problems.push(`"${name}" needs a number.`);
    }
    const expected = RATINGS.get(name) ?? null;
    const given = r.unit === undefined || r.unit === '' ? undefined : r.unit;
    if (given !== undefined && given !== expected) {
      problems.push(`"${name}" is measured in ${expected ? `"${expected}"` : 'no unit (a pure number)'}, not "${given}".`);
    }
    if (typeof r.source !== 'string' || !r.source.trim()) {
      problems.push(`"${name}" needs a source: the datasheet or catalogue page the figure came from.`);
    }
  }
  if (problems.length) throw new BadRequestException(problems.join(' '));
  return ratings.map((r) => ({ name: r.name.trim(), value: r.value, source: r.source.trim() }));
}

export function toView(row: { name: string; value: number; source: string; updatedBy: string; updatedAt: Date }): RatingView {
  return { name: row.name, value: row.value, unit: ratingUnit(row.name), source: row.source, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
}
