/**
 * One-off: load the master sensor reference catalog from mockData.ts's
 * INITIAL_SENSORS into the real backend (device-catalog.write), via the same
 * REST API the console itself calls. Idempotent — safe to re-run; existing
 * categories/sensors (matched by name) are left alone.
 *
 * Run with: npx tsx scripts/seed-sensors.ts
 */
import { INITIAL_SENSORS } from '../src/data/mockData';

const BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:8080/api/v1';
const EMAIL = 'support@thingsalive.io';
const PASSWORD = 'Admin@2026!!';

async function main() {
  const signIn = await fetch(`${BASE_URL}/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!signIn.ok) throw new Error(`Sign-in failed: ${signIn.status} ${await signIn.text()}`);
  const { accessToken } = await signIn.json();

  const authed = (path: string, init: RequestInit = {}) =>
    fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, ...init.headers },
    });

  const existingCategories: { id: string; name: string }[] = await (await authed('/device-catalog/categories')).json();
  const categoryByName = new Map(existingCategories.map((c) => [c.name, c.id]));

  // Keyed by (name, category) rather than name alone — the mock catalog reuses a
  // display name across categories on purpose (e.g. "Torque_Sensor" under both
  // Engine and Transmission, each measuring something different).
  const existingSensors: { sensorName: string; categoryId: string | null }[] =
    await (await authed('/device-catalog/sensors')).json();
  const sensorKeys = new Set(existingSensors.map((s) => `${s.sensorName}::${s.categoryId ?? ''}`));

  let categoriesCreated = 0;
  let sensorsCreated = 0;
  let sensorsSkipped = 0;

  for (const sensor of INITIAL_SENSORS) {
    let categoryId: string | undefined;
    if (sensor.category) {
      categoryId = categoryByName.get(sensor.category);
      if (!categoryId) {
        const res = await authed('/device-catalog/categories', {
          method: 'POST', body: JSON.stringify({ name: sensor.category }),
        });
        if (!res.ok) throw new Error(`Category "${sensor.category}" failed: ${res.status} ${await res.text()}`);
        const created = await res.json();
        categoryId = created.id;
        categoryByName.set(sensor.category, categoryId as string);
        categoriesCreated += 1;
      }
    }

    const key = `${sensor.sensorName}::${categoryId ?? ''}`;
    if (sensorKeys.has(key)) {
      sensorsSkipped += 1;
      continue;
    }

    const res = await authed('/device-catalog/sensors', {
      method: 'POST',
      body: JSON.stringify({
        sensorName: sensor.sensorName,
        categoryId,
        description: sensor.description,
        protocol: sensor.protocol,
        parameterSpecs: sensor.parameterSpecs ?? [],
      }),
    });
    if (!res.ok) throw new Error(`Sensor "${sensor.sensorName}" failed: ${res.status} ${await res.text()}`);
    sensorKeys.add(key);
    sensorsCreated += 1;
  }

  console.log(
    `Categories created: ${categoriesCreated}. Sensors created: ${sensorsCreated}. ` +
    `Sensors skipped (already present): ${sensorsSkipped}. Total in mock data: ${INITIAL_SENSORS.length}.`,
  );
}

main().catch((err) => { console.error(err); process.exit(1); });
