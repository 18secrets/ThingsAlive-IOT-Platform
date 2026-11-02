import { AssistantModel, AssistantTurn, ModelReply, ToolDeclaration } from '../src/assistant/assistant-model';
import { frameModelFromEnv, GEMINI_FRAME_VERSION, GeminiFrameModel, parseJsonObject } from '../src/rec-frame/gemini-frame-model';
import { BundleView, GroundedAnswer } from '../src/rec-frame/grounded-answer';

/** What Gemini is asked and what it says back, scripted: the provider itself is never called. */
class ScriptedModel implements AssistantModel {
  readonly name = 'gemini-test-flash';
  asked: { system: string; turns: AssistantTurn[]; tools: ToolDeclaration[] }[] = [];
  constructor(private readonly reply: (input: { system: string; turns: AssistantTurn[] }) => string | null) {}
  async generate(input: { system: string; turns: AssistantTurn[]; tools: ToolDeclaration[] }): Promise<ModelReply> {
    this.asked.push(input);
    return { text: this.reply(input), calls: [], tokens: 10 };
  }
}

const bundle = { id: 'b-1', asOf: '2026-10-19T12:00:00.000Z' } as unknown as BundleView;
const templateFrame = {
  answer_id: 'a-1', context_id: 'c-1', status: 'answered', summary: 'Overheat: one open alert on coolant_temp.',
  observations: [{ claim: 'coolant_temp has an open alert.', evidence_refs: ['alert_event:00000000-0000-0000-0000-000000000001'] }],
  hypotheses: [], next_steps: [{ aim: 'Flush coolant', expected_outcome: 'Coolant back in range.', required_capability: 'work.create', simulation_available: false }],
  citations: [], missing_inputs: [], as_of: '2026-10-19T12:00:00.000Z', limitations: [],
} as GroundedAnswer;

/**
 * Gemini as the recommendation frame's model (QREC2 §6.1). It may only rephrase the
 * template frame; the frame service's critic decides whether what it wrote is served
 * (rec-frame.spec 13–19b). What is tested here is the adapter's half: it hands Gemini
 * the bundle and the template frame and no tools, tells it the rules, and turns its
 * reply into an object or a failure — never into something half-read.
 */
describe('Gemini frame model', () => {
  it('1. asks once, with the bundle and the template frame, the rewrite rules, and no tools', async () => {
    const model = new ScriptedModel(() => JSON.stringify({ ...templateFrame, summary: 'Coolant is overheating: one alert is open.' }));
    const frame = new GeminiFrameModel(model);

    const out = await frame.frame({ bundle, templateFrame });

    expect(model.asked).toHaveLength(1);
    const [{ system, turns, tools }] = model.asked;
    expect(tools).toEqual([]);
    expect(turns).toHaveLength(1);
    const text = (turns[0] as { text: string }).text;
    expect(text).toContain(JSON.stringify(bundle));
    expect(text).toContain(JSON.stringify(templateFrame));
    // The rules the critic enforces, stated up front so fewer replies are thrown away.
    for (const rule of [/evidence_refs/, /copy it exactly/, /no number/i, /probability/i, /JSON object only/]) {
      expect(system).toMatch(rule);
    }
    expect(out).toEqual({ ...templateFrame, summary: 'Coolant is overheating: one alert is open.' });
  });

  it('2. names the model that wrote the frame and the version of the rules it wrote under', () => {
    const frame = new GeminiFrameModel(new ScriptedModel(() => null));
    expect(frame.id).toBe('gemini-test-flash');
    expect(frame.version).toBe(GEMINI_FRAME_VERSION);
  });

  it('3. a reply fenced as ```json is unwrapped, as Gemini does whatever it is told', async () => {
    const frame = new GeminiFrameModel(new ScriptedModel(() => '```json\n' + JSON.stringify(templateFrame) + '\n```'));
    expect(await frame.frame({ bundle, templateFrame })).toEqual(templateFrame);
  });

  it('4. no text, prose, or JSON that is not one object is an error, so the template frame is served', async () => {
    for (const reply of [null, 'Here is the rewritten frame: …', '[1, 2]', '"just a string"']) {
      const frame = new GeminiFrameModel(new ScriptedModel(() => reply));
      await expect(frame.frame({ bundle, templateFrame })).rejects.toThrow(/frame model/);
    }
    expect(() => parseJsonObject('{"summary": "ok"} trailing')).toThrow(/did not return JSON/);
  });

  it('5. bound only when the assistant\'s Gemini is configured: no model name or no route is no model', () => {
    expect(frameModelFromEnv({})).toBeNull();
    expect(frameModelFromEnv({ ASSISTANT_MODEL: 'gemini-test-flash' })).toBeNull();
    expect(frameModelFromEnv({ ASSISTANT_GEMINI_API_KEY: 'k' })).toBeNull();
    const bound = frameModelFromEnv({ ASSISTANT_MODEL: 'gemini-test-flash', ASSISTANT_GEMINI_API_KEY: 'k' });
    expect(bound).toBeInstanceOf(GeminiFrameModel);
    expect(bound!.id).toBe('gemini-test-flash');
  });
});
