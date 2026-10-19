import { GoogleGenAI } from '@google/genai';

/**
 * The answer model, behind the smallest interface the chat loop needs.
 *
 * Our own types rather than the SDK's, so the loop, its budget and its tests do not
 * change when the provider does. D08 puts the provider choice in Master Admin
 * configuration; until that screen exists the choice is made by environment, and
 * this interface is what both will configure.
 */
export type AssistantTurn =
  | { role: 'user'; text: string }
  | { role: 'model'; text: string }
  | { role: 'model'; calls: ToolCall[] }
  | { role: 'tool'; results: { name: string; result: unknown }[] };

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  /**
   * Opaque provider state that must travel back with the call. Gemini 3 signs each
   * function call with its reasoning and refuses the next turn (400) if the call
   * comes back without its signature. Found by the first live call, not by the
   * scripted tests, which have no reason to produce one.
   */
  signature?: string;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ModelReply {
  text: string | null;
  calls: ToolCall[];
  /** Prompt plus output, as the provider counts them. What the daily budget spends. */
  tokens: number;
}

export interface AssistantModel {
  readonly name: string;
  generate(input: { system: string; turns: AssistantTurn[]; tools: ToolDeclaration[] }): Promise<ModelReply>;
}

export const ASSISTANT_MODEL = Symbol('ASSISTANT_MODEL');

/**
 * Gemini reached one of two ways. Vertex AI is the target (project billing, IAM, data
 * residency). A Gemini API key is what IoT Platform 1.0 already runs on, so it is
 * also accepted: it turns the assistant on today, with the same key and model as
 * 1.0, while a Vertex project is set up.
 */
export type GeminiConfig =
  | {
    mode: 'vertex';
    project: string;
    location: string;
    model: string;
    /** A service-account key as JSON. Absent means application default credentials. */
    credentials: Record<string, unknown> | null;
  }
  | { mode: 'api-key'; apiKey: string; model: string };

/**
 * Half a configuration is none. The model name has no default on purpose: a default
 * here is a model id written down today that Google retires next year, and the
 * failure then is every chat erroring on Development rather than a clear "not
 * configured" at boot. When both routes are configured, Vertex wins.
 */
export function geminiConfigFrom(env: Record<string, string | undefined>): GeminiConfig | null {
  const model = env.ASSISTANT_MODEL?.trim();
  if (!model) return null;
  const project = env.ASSISTANT_VERTEX_PROJECT?.trim();
  const location = env.ASSISTANT_VERTEX_LOCATION?.trim();
  if (project && location) {
    const raw = env.ASSISTANT_VERTEX_CREDENTIALS_JSON?.trim();
    let credentials: Record<string, unknown> | null = null;
    if (raw) {
      try {
        credentials = JSON.parse(raw);
      } catch {
        // The key itself is never echoed: a parse error message can quote the input.
        throw new Error('ASSISTANT_VERTEX_CREDENTIALS_JSON is set but is not valid JSON.');
      }
    }
    return { mode: 'vertex', project, location, model, credentials };
  }
  const apiKey = env.ASSISTANT_GEMINI_API_KEY?.trim();
  if (apiKey) return { mode: 'api-key', apiKey, model };
  return null;
}

/** Gemini, on Vertex AI or with an API key. */
export class GeminiModel implements AssistantModel {
  private readonly ai: GoogleGenAI;
  readonly name: string;

  constructor(config: GeminiConfig) {
    this.name = config.model;
    this.ai = config.mode === 'vertex'
      ? new GoogleGenAI({
        vertexai: true, project: config.project, location: config.location,
        ...(config.credentials ? { googleAuthOptions: { credentials: config.credentials } } : {}),
      })
      : new GoogleGenAI({ apiKey: config.apiKey });
  }

  async generate(input: { system: string; turns: AssistantTurn[]; tools: ToolDeclaration[] }): Promise<ModelReply> {
    const res = await this.ai.models.generateContent({
      model: this.name,
      contents: input.turns.map((t) => {
        if (t.role === 'tool') {
          return {
            role: 'user',
            parts: t.results.map((r) => ({ functionResponse: { name: r.name, response: { result: r.result } } })),
          };
        }
        if ('calls' in t) {
          return {
            role: 'model',
            parts: t.calls.map((c) => ({
              functionCall: { name: c.name, args: c.args },
              ...(c.signature ? { thoughtSignature: c.signature } : {}),
            })),
          };
        }
        return { role: t.role, parts: [{ text: t.text }] };
      }),
      config: {
        systemInstruction: input.system,
        // Low, not zero: the answers are read off tool results, and a creative model
        // is one that rounds a reading or invents a machine name.
        temperature: 0.2,
        maxOutputTokens: 1024,
        ...(input.tools.length ? {
          tools: [{
            functionDeclarations: input.tools.map((d) => ({
              name: d.name, description: d.description, parametersJsonSchema: d.parameters,
            })),
          }],
        } : {}),
      },
    });
    // Read off the parts rather than `res.text` / `res.functionCalls`: the signature
    // sits on the part, beside the call, and the shortcuts drop it.
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
    return {
      text: text || null,
      calls: parts.filter((p) => p.functionCall).map((p) => ({
        name: p.functionCall!.name ?? '',
        args: (p.functionCall!.args ?? {}) as Record<string, unknown>,
        ...(p.thoughtSignature ? { signature: p.thoughtSignature } : {}),
      })),
      tokens: res.usageMetadata?.totalTokenCount ?? 0,
    };
  }
}
