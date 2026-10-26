import { RequestScope } from '../src/auth/types/request-scope';
import { RecEngineController } from '../src/rec-engine/rec-engine.controller';
import { RecEngineService } from '../src/rec-engine/rec-engine.service';

/**
 * "Analyse again" returned the 23 Oct bundle on 26 Oct and the screen read
 * "Analysed 23/10/2026" as if nothing had run: unchanged evidence returns the bundle
 * first written for it, by design. The response now also says when this check ran and
 * that the evidence was unchanged; the bundle itself is returned as stored.
 */
describe('POST rec-evidence: when the check ran, and whether the evidence moved', () => {
  const scope = { tenantId: 'acme' } as RequestScope;
  const stored = { id: 'b-1', asOf: new Date('2026-10-23T04:37:50.000Z'), outcome: 'nothing_detected' };
  const run = async (created: boolean) => {
    let status = 0;
    const engine = { evaluate: async () => ({ bundle: stored, created }) } as unknown as RecEngineService;
    const before = Date.now();
    const body = await new RecEngineController(engine).evaluate(scope, 'ta-2.0', 'EX-01', { status: (s: number) => { status = s; } });
    return { body: body as typeof stored & { checkedAt: string; evidenceUnchanged: boolean }, status, before };
  };

  it('unchanged evidence: 200, the stored bundle with its own asOf, checkedAt now, evidenceUnchanged', async () => {
    const { body, status, before } = await run(false);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: 'b-1', asOf: stored.asOf, outcome: 'nothing_detected', evidenceUnchanged: true });
    expect(new Date(body.checkedAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('new evidence: 201, evidenceUnchanged false', async () => {
    const { body, status } = await run(true);
    expect(status).toBe(201);
    expect(body.evidenceUnchanged).toBe(false);
  });
});
