/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The first slice of real backend integration: sign-in, session refresh and
// sign-out against Platform 2.0's actual /auth routes. Every other screen in
// this app still reads and writes mock data — see App.tsx.

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080/api/v1';

// The refresh token is the only thing persisted, and it goes in sessionStorage
// rather than localStorage — per tab, matching this app's existing session
// model (see App.tsx's SESSION_KEY comment). The access token lives only in
// memory: it is never written to storage, and a page reload loses it on
// purpose, recovered via one refresh call rather than kept lying around.
const REFRESH_KEY = 'ta_api_refresh_token';
let accessToken: string | null = null;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface SignedInUser {
  id: string;
  email: string;
  fullName: string;
  tenantId: string;
  roleSlug: string;
}

interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  user: SignedInUser;
}

async function parse(res: Response): Promise<any> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(body?.error?.message ?? 'Request failed.', res.status);
  }
  return body;
}

function store(tokens: SessionTokens) {
  accessToken = tokens.accessToken;
  sessionStorage.setItem(REFRESH_KEY, tokens.refreshToken);
}

function clear() {
  accessToken = null;
  sessionStorage.removeItem(REFRESH_KEY);
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function hasStoredSession(): boolean {
  return !!sessionStorage.getItem(REFRESH_KEY);
}

export async function apiSignIn(email: string, password: string): Promise<SignedInUser> {
  const res = await fetch(`${BASE_URL}/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body: SessionTokens = await parse(res);
  store(body);
  return body.user;
}

export async function apiAcceptInvitation(token: string, password: string): Promise<SignedInUser> {
  const res = await fetch(`${BASE_URL}/auth/accept-invitation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });
  const body: SessionTokens = await parse(res);
  store(body);
  return body.user;
}

/** Exchanges the stored refresh token for a fresh access token. False means the session is dead. */
export async function apiResume(): Promise<SignedInUser | null> {
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return null;
  try {
    const res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    const body: SessionTokens = await parse(res);
    store(body);
    return body.user;
  } catch {
    clear();
    return null;
  }
}

export async function apiSignOut(): Promise<void> {
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  clear();
  if (!refreshToken) return;
  try {
    await fetch(`${BASE_URL}/auth/sign-out`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // Best-effort — the local session is already cleared either way, and a
    // dead server shouldn't be able to trap someone in a signed-in tab.
  }
}

// ------------------------------------------------------------- authenticated calls

/**
 * Every call past sign-in goes through here. One retry after one silent
 * refresh — not a loop — because a refresh token that still fails once
 * rotated is dead, and retrying it again would just be a slower way to find
 * that out.
 */
async function authFetch(path: string, init: RequestInit = {}, retried = false): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401 && !retried) {
    const resumed = await apiResume();
    if (resumed) return authFetch(path, init, true);
  }
  return parse(res);
}

export interface SuperAdminContact {
  fullName: string;
  email: string;
  phone: string | null;
  /** 'invited' until they accept and set a password. */
  status: 'invited' | 'active' | 'suspended';
}

export interface Account {
  tenantId: string;
  name: string;
  status: 'active' | 'suspended';
  plan: string | null;
  region: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  provisionedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** The account's ceo-manager — see ProvisioningService.superAdminsFor. Only
   *  absent if a tenant row exists with no super admin, which the API's own
   *  provisioning flow never produces. */
  superAdmin: SuperAdminContact | null;
}

export interface CreateAccountResult {
  tenant: Account;
  roles: string[];
  superAdmin: { id: string; email: string };
  invitationToken: string;
  invitationExpiresAt: string;
  alreadyExisted: boolean;
}

export function apiListAccounts(): Promise<Account[]> {
  return authFetch('/accounts');
}

export function apiCreateAccount(input: {
  tenantId: string;
  name: string;
  superAdmin: { email: string; fullName: string; phone?: string };
}): Promise<CreateAccountResult> {
  return authFetch('/accounts', { method: 'POST', body: JSON.stringify(input) });
}

export function apiUpdateAccount(tenantId: string, input: {
  name?: string;
  superAdmin?: { fullName?: string; email?: string; phone?: string };
}): Promise<Account> {
  return authFetch(`/accounts/${encodeURIComponent(tenantId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function apiSuspendAccount(tenantId: string, reason: string): Promise<Account> {
  return authFetch(`/accounts/${encodeURIComponent(tenantId)}/suspend`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function apiReinstateAccount(tenantId: string): Promise<Account> {
  return authFetch(`/accounts/${encodeURIComponent(tenantId)}/reinstate`, { method: 'POST' });
}

export interface ResendInvitationResult {
  email: string;
  invitationToken: string;
  invitationExpiresAt: string;
}

/** Only works while the super admin has never accepted — see the backend's own comment. */
export function apiResendInvitation(tenantId: string): Promise<ResendInvitationResult> {
  return authFetch(`/accounts/${encodeURIComponent(tenantId)}/resend-invitation`, { method: 'POST' });
}
