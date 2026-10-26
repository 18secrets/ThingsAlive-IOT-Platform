import { ThinkingLevel } from '@google/genai';
import { GeminiModel, thinkingOff } from '../src/assistant/assistant-model';

/**
 * Dev's assistant answered nothing: gemini-3.5-flash-lite refuses `thinkingBudget: 0`
 * with "Request contains an invalid argument", and every chat and onboarding answer came
 * back assistant_unavailable. Gemini 3 turns thinking down by level; Gemini 2 by budget,
 * and refuses a level ("Thinking level is not supported for this model").
 */
describe('turning thinking off, per Gemini generation', () => {
  it('Gemini 3 and later: the minimal level, never a budget', () => {
    for (const m of ['gemini-3.5-flash-lite', 'gemini-3-flash', 'gemini-10-flash']) {
      expect(thinkingOff(m)).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
    }
  });

  it('Gemini 2: a budget of zero, never a level', () => {
    for (const m of ['gemini-2.5-flash', 'gemini-2.0-flash-lite']) expect(thinkingOff(m)).toEqual({ thinkingBudget: 0 });
  });

  it('what is sent: a Flash 3 call carries the level, a Pro call carries neither', async () => {
    const sentFor = async (name: string) => {
      const model = new GeminiModel({ mode: 'api-key', apiKey: 'unused', model: name });
      let config: Record<string, unknown> = {};
      (model as unknown as { ai: unknown }).ai = {
        models: {
          generateContent: async (req: { config: Record<string, unknown> }) => {
            config = req.config;
            return { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { totalTokenCount: 1 } };
          },
        },
      };
      await model.generate({ system: 's', turns: [{ role: 'user', text: 'q' }], tools: [] });
      return config;
    };
    expect((await sentFor('gemini-3.5-flash-lite')).thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
    expect((await sentFor('gemini-2.5-flash')).thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect((await sentFor('gemini-3-pro')).thinkingConfig).toBeUndefined();
  });
});
