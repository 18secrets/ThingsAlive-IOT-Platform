/**
 * The refusal for new content that names a retired sensor (task QCAT2).
 *
 * One wording, wherever new content is checked: the tool-mapping path here today, and
 * the workbook validator (`sensor-review.ts`, Stream A's) when it calls this. Two
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
