/** The seed demo tenant (seed-demo's DEMO_TENANT). Its twin is drawn as a simulation —
 * every machine at a work front moves and tippers haul — and says so on screen. No real
 * customer's twin is: theirs moves only on their own live data.
 *
 * In a module of its own so the twin service can read it without importing the demo
 * stream, which itself builds the service. */
export const SIMULATED_TENANTS: ReadonlySet<string> = new Set(['demo-construction']);
