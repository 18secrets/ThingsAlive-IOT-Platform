/**
 * The one way this console talks to 2.0.
 *
 * Three decisions are load-bearing and none of them are stylistic.
 *
 * The access token lives in a module variable and never in storage. A token in
 * localStorage is readable by any script that ends up on the page and is valid
 * everywhere the moment it is read; the refresh token is the one the platform can
 * revoke, so it is the only one worth persisting and the only one persisted.
 *
 * Exactly one refresh is in flight at a time. 2.0 rotates refresh tokens and treats a
 * second use of a rotated one as theft — correctly. Without the shared promise below,
 * three components mounting together each hit a 401, each send the same refresh token,
 * two of them lose, and the reuse detector revokes the session. The bug presents to a
 * user as "signing in signs me out", which is a long way from where it is caused.
 *
 * And a failed refresh signs out rather than retrying. A retry loop against an expired
 * session is how a browser tab quietly hammers an endpoint for an hour.
 */

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
const REFRESH_KEY = 'ta.refresh';

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSignedOut: (() => void) | null = null;

export type Tokens = { accessToken: string; refreshToken: string; expiresInSeconds: number };

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
  }
}

export const session = {
  /** Whether a refresh token is on hand — not whether it still works. */
  looksSignedIn: () => Boolean(readRefresh()),
  onSignedOut(fn: () => void) { onSignedOut = fn; },
  adopt(tokens: Tokens) {
    accessToken = tokens.accessToken;
    writeRefresh(tokens.refreshToken);
  },
  clear() {
    accessToken = null;
    writeRefresh(null);
  },
};

function readRefresh(): string | null {
  // Storage throws in a private window and in an iframe with site data blocked. A
  // console that cannot read a token is signed out; it is not broken.
  try { return localStorage.getItem(REFRESH_KEY); } catch { return null; }
}

function writeRefresh(value: string | null) {
  try {
    if (value === null) localStorage.removeItem(REFRESH_KEY);
    else localStorage.setItem(REFRESH_KEY, value);
  } catch { /* nothing to do: the session is then in-memory only */ }
}

async function parse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * The platform distinguishes a wrong password from a locked account from a suspended
 * organisation, and those need three different things from the person reading them.
 * So the server's own message is what surfaces, and only a response without one falls
 * back to something generic.
 */
function messageFrom(status: number, body: any): string {
  const m = body?.message;
  if (Array.isArray(m) && m.length) return m.join('. ');
  if (typeof m === 'string' && m) return m;
  if (typeof body?.error === 'string' && body.error) return body.error;
  if (status === 0) return 'The platform did not answer. Check the API address and that this origin is allowed by CORS.';
  return `Request failed (${status}).`;
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  try {
    return await fetch(`${BASE}${path}`, { ...init, headers });
  } catch (cause) {
    // A CORS rejection and a dead host are indistinguishable from here by design.
    throw new ApiError(0, messageFrom(0, null), cause);
  }
}

async function refresh(): Promise<boolean> {
  const token = readRefresh();
  if (!token) return false;
  const res = await send('/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken: token }),
  });
  if (!res.ok) return false;
  const tokens = (await parse(res)) as Tokens;
  if (!tokens?.accessToken) return false;
  session.adopt(tokens);
  return true;
}

async function refreshOnce(): Promise<boolean> {
  refreshing ??= refresh().finally(() => { refreshing = null; });
  return refreshing;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, body: body === undefined ? undefined : JSON.stringify(body) };
  let res = await send(path, init);

  if (res.status === 401 && readRefresh()) {
    if (await refreshOnce()) {
      res = await send(path, init);
    } else {
      session.clear();
      onSignedOut?.();
    }
  }

  const payload = await parse(res);
  if (!res.ok) throw new ApiError(res.status, messageFrom(res.status, payload), payload);
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),

  async signIn(email: string, password: string): Promise<Tokens> {
    const res = await send('/auth/sign-in', { method: 'POST', body: JSON.stringify({ email, password }) });
    const payload = await parse(res);
    if (!res.ok) throw new ApiError(res.status, messageFrom(res.status, payload), payload);
    session.adopt(payload as Tokens);
    return payload as Tokens;
  },

  async signOut(): Promise<void> {
    const token = readRefresh();
    session.clear();
    // Best effort: the local session is gone either way, and a server that refuses
    // this must not keep somebody looking at a console they have left.
    if (token) {
      try { await send('/auth/sign-out', { method: 'POST', body: JSON.stringify({ refreshToken: token }) }); }
      catch { /* already signed out locally */ }
    }
  },

  /** Restores a session on a cold load, when only the refresh token survived. */
  resume: () => refreshOnce(),
};
