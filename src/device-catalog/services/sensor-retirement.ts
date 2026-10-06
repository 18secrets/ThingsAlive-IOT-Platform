import { BadRequestException } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';

/**
 * The refusal for new content that names a retired sensor (task QCAT2).
 *
 * One wording for tool mappings, workbook resolution and the database guard. Two
 * paths phrasing the same refusal differently is how they drift into checking
 * different things.
 */
export function retiredSensorProblem(
  sensor: { sensorName: string; slug: string; retiredAt: Date | null },
): string | null {
  if (!sensor.retiredAt) return null;
  return `sensor "${sensor.sensorName}" (${sensor.slug}) was retired on `
    + `${sensor.retiredAt.toISOString().slice(0, 10)} and cannot be used on new content (sensor_retired).`;
}

/** A role can have several interchangeable sensors. Retirement blocks new use only
 * when every matching capability is retired; uncatalogued legacy roles stay valid. */
export async function retiredSignalProblems(
  manager: EntityManager, signals: { signal: string; unit: string | null }[],
): Promise<string[]> {
  if (!signals.length) return [];
  const [row] = await manager.query(
    'SELECT sensor_retirement_problems($1::jsonb) AS problems', [JSON.stringify(signals)],
  );
  return row.problems;
}

export function rethrowSensorContentError(error: unknown): never {
  if (error instanceof QueryFailedError && /\(sensor_(retired|reference)\)/.test(error.message)) {
    throw new BadRequestException(error.message);
  }
  throw error;
}
