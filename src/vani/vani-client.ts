/**
 * The HTTP edge to Vani (integration guide §2, §6). Knows how to reach it and nothing
 * about what the answers mean; `VaniCallSender` decides that.
 *
 * VANI_PLATFORM_TOKEN is the platform token Vani operations issue. It is read here and
 * put on the wire, and goes nowhere else: not into a log line, an error message or a
 * stored row. Without it, or without VANI_BASE_URL, the client reports itself
 * unconfigured and sends nothing.
 */
export interface VaniResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface VaniTransport {
  readonly configured: boolean;
  post(path: string, body: unknown): Promise<VaniResponse>;
}

export class VaniClient implements VaniTransport {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly timeoutMs = 10_000) {}

  get configured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  private get baseUrl(): string {
    return `${this.env.VANI_BASE_URL ?? ''}`.trim().replace(/\/+$/, '');
  }

  private get token(): string {
    return `${this.env.VANI_PLATFORM_TOKEN ?? ''}`.trim();
  }

  async post(path: string, body: unknown): Promise<VaniResponse> {
    if (!this.configured) throw new Error('Vani is not configured: set VANI_BASE_URL and VANI_PLATFORM_TOKEN.');
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try {
      const value = text ? JSON.parse(text) : {};
      parsed = value && typeof value === 'object' ? value : { value };
    } catch {
      // Not JSON: a proxy's error page, say. Kept short, as text, for the row.
      parsed = { error: text.slice(0, 300) };
    }
    return { status: res.status, body: parsed };
  }
}
