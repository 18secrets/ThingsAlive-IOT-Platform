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

export interface VertexConfig {
  project: string;
  location: string;
  model: string;
  /** A service-account key as JSON. Absent means application default credentials. */
  credentials: Record<string, unknown> | null;
}

/**
 * Half a configuration is none. The model name has no default on purpose: a default
 * here is a model id written down today that Google retires next year, and the
 * failure then is every chat erroring on Development rather than a clear "not
 * configured" at boot.
 */
export function vertexConfigFrom(env: Record<string, string | undefined>): VertexConfig | null {
  const project = env.ASSISTANT_VERTEX_PROJECT?.trim();
  const location = env.ASSISTANT_VERTEX_LOCATION?.trim();
  const model = env.ASSISTANT_MODEL?.trim();
  if (!project || !location || !model) return null;
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
  return { project, location, model, credentials };
}

/** Gemini on Vertex AI. */
export class VertexGeminiModel implements AssistantModel {
  private readonly ai: GoogleGenAI;
  readonly name: string;

  constructor(config: VertexConfig) {
    this.name = config.model;
    this.ai = new GoogleGenAI({
      vertexai: true, project: config.project, location: config.location,
      ...(config.credentials ? { googleAuthOptions: { credentials: config.credentials } } : {}),
    });
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
          return { role: 'model', parts: t.calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) };
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
    return {
      text: res.text?.trim() || null,
      calls: (res.functionCalls ?? []).map((c) => ({ name: c.name ?? '', args: (c.args ?? {}) as Record<string, unknown> })),
      tokens: res.usageMetadata?.totalTokenCount ?? 0,
    };
  }
}
