/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The first slice of real backend integration: sign-in, session refresh and
// sign-out against Platform 2.0's actual /auth routes. Every other screen in
// this app still reads and writes mock data — see App.tsx.

import { mutationKind, reportMutation } from "./mutationNotice";

const BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080/api/v1";

// The refresh token is the only thing persisted, and it goes in sessionStorage
// rather than localStorage — per tab, matching this app's existing session
// model (see App.tsx's SESSION_KEY comment). The access token lives only in
// memory: it is never written to storage, and a page reload loses it on
// purpose, recovered via one refresh call rather than kept lying around.
const REFRESH_KEY = "ta_api_refresh_token";
let accessToken: string | null = null;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
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
    throw new ApiError(body?.error?.message ?? "Request failed.", res.status);
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

// AuthProvider registers a handler here so that a refresh token dying mid-session
// (not just on cold load) forces authUser back to null. Without this, a 401 whose
// retry-resume also fails leaves `authUser` stale and every future call repeats
// the same failed dance forever — the screen stays rendered as signed in while
// nothing it does ever works, because no token is ever attached again.
let onSessionDead: (() => void) | null = null;
export function setSessionDeadHandler(handler: (() => void) | null): void {
  onSessionDead = handler;
}

// Why the server last refused to renew the session ("This account has been
// suspended."), so the sign-in screen can say it instead of appearing for no reason
// (tester bugs TC_136, TC_137). Read once: it explains one sign-out, not the next.
let sessionEndReason: string | null = null;
export function takeSessionEndReason(): string | null {
  const reason = sessionEndReason;
  sessionEndReason = null;
  return reason;
}

export async function apiSignIn(
  email: string,
  password: string,
): Promise<SignedInUser> {
  const res = await fetch(`${BASE_URL}/auth/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body: SessionTokens = await parse(res);
  store(body);
  return body.user;
}

async function postAcceptInvitation(path: string, token: string, password: string): Promise<SessionTokens> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password }),
  });
  return parse(res);
}

/**
 * A tenant invitation and a Things Alive staff invitation look identical from here —
 * only the backend can tell which table a given token's hash actually belongs to
 * (`user_invitation` vs `platform_invitation`). Tried as the tenant route first since
 * that is the common case; a 401 there means "not this one," not "wrong password"
 * (there is no current password on an invitation), so it's safe to retry the staff
 * route before surfacing a refusal.
 */
export async function apiAcceptInvitation(
  token: string,
  password: string,
): Promise<SignedInUser> {
  try {
    const body = await postAcceptInvitation("/auth/accept-invitation", token, password);
    store(body);
    return body.user;
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
    const body = await postAcceptInvitation("/platform/auth/accept-invitation", token, password);
    store(body);
    return body.user;
  }
}

/**
 * Always resolves the same way, known account or not — the response can't be
 * allowed to tell someone whether an email address has an account here.
 */
export async function apiForgotPassword(email: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  await parse(res);
}

/** Exchanges the stored refresh token for a fresh access token. False means the session is dead. */
export async function apiResume(): Promise<SignedInUser | null> {
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return null;
  try {
    const res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    const body: SessionTokens = await parse(res);
    store(body);
    return body.user;
  } catch (err) {
    clear();
    // Only the server's own refusal; a network failure says nothing about the account.
    sessionEndReason = err instanceof ApiError && err.status === 401 ? err.message : null;
    return null;
  }
}

export async function apiSignOut(): Promise<void> {
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  clear();
  if (!refreshToken) return;
  try {
    await fetch(`${BASE_URL}/auth/sign-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
async function authFetch(
  path: string,
  init: RequestInit = {},
  retried = false,
): Promise<any> {
  const kind = mutationKind(path, init.method);
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...init.headers,
      },
    });
  } catch (err) {
    if (kind) reportMutation({ ok: false, kind, message: null });
    throw err;
  }
  if (res.status === 401 && !retried) {
    const resumed = await apiResume();
    if (resumed) return authFetch(path, init, true);
    // The refresh token is genuinely dead, not just this access token. Force the
    // rest of the app to notice now, rather than parsing this one response as an
    // ordinary error and leaving `authUser` pointing at a session that no longer
    // exists.
    onSessionDead?.();
  }
  // Only the final answer is reported: a 401 that a refresh then retried is not a
  // failure, and one that ends the session is the sign-in screen's to explain.
  if (!kind || res.status === 401) return parse(res);
  try {
    const body = await parse(res);
    reportMutation({ ok: true, kind });
    return body;
  } catch (err) {
    reportMutation({ ok: false, kind, message: err instanceof ApiError ? err.message : null });
    throw err;
  }
}

/**
 * Same retry-once-on-401 shape as `authFetch`, but hands back the raw `Response`
 * instead of parsing it as JSON — for a multipart upload (no fixed Content-Type; the
 * browser has to set its own boundary) and a binary download (the body is a workbook,
 * not JSON).
 */
async function authFetchRaw(
  path: string,
  init: RequestInit = {},
  retried = false,
): Promise<Response> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401 && !retried) {
    const resumed = await apiResume();
    if (resumed) return authFetchRaw(path, init, true);
    onSessionDead?.();
  }
  const kind = mutationKind(path, init.method);
  if (kind && res.status !== 401) {
    // A clone, so the caller still reads the body it expects.
    const message = res.ok ? null : (await res.clone().json().catch(() => ({})))?.error?.message ?? `Request failed (${res.status}).`;
    reportMutation(res.ok ? { ok: true, kind } : { ok: false, kind, message });
  }
  return res;
}

export interface SuperAdminContact {
  fullName: string;
  email: string;
  phone: string | null;
  /** 'invited' until they accept and set a password. */
  status: "invited" | "active" | "suspended";
}

export interface Account {
  tenantId: string;
  name: string;
  status: "active" | "suspended";
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
  return authFetch("/accounts");
}

export function apiCreateAccount(input: {
  tenantId: string;
  name: string;
  superAdmin: { email: string; fullName: string; phone?: string };
}): Promise<CreateAccountResult> {
  return authFetch("/accounts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function apiUpdateAccount(
  tenantId: string,
  input: {
    name?: string;
    superAdmin?: { fullName?: string; email?: string; phone?: string };
  },
): Promise<Account> {
  return authFetch(`/accounts/${encodeURIComponent(tenantId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function apiSuspendAccount(
  tenantId: string,
  reason: string,
): Promise<Account> {
  return authFetch(`/accounts/${encodeURIComponent(tenantId)}/suspend`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/** Only a suspended account nobody ever signed in to, holding no data. */
export function apiDeleteAccount(tenantId: string): Promise<void> {
  return authFetch(`/accounts/${encodeURIComponent(tenantId)}`, { method: "DELETE" });
}

export function apiReinstateAccount(tenantId: string): Promise<Account> {
  return authFetch(`/accounts/${encodeURIComponent(tenantId)}/reinstate`, {
    method: "POST",
  });
}

export interface ResendInvitationResult {
  email: string;
  invitationToken: string;
  invitationExpiresAt: string;
}

/** Only works while the super admin has never accepted — see the backend's own comment. */
export function apiResendInvitation(
  tenantId: string,
): Promise<ResendInvitationResult> {
  return authFetch(
    `/accounts/${encodeURIComponent(tenantId)}/resend-invitation`,
    { method: "POST" },
  );
}

// ------------------------------------------------------------------ platform staff

/**
 * Things Alive's own people (/platform/staff, `platform.admin` — master admin
 * only). A separate population from `Account`/`ClientAccount`: staff sign in as
 * platform users (master-admin, platform-support, catalog-author), never scoped to
 * a tenant, and this is the only place they're created after the very first one.
 */
export type PlatformStaffRole = "master-admin" | "platform-support" | "catalog-author";
export type PlatformStaffStatus = "invited" | "active" | "suspended";

export interface PlatformStaffMember {
  id: string;
  email: string;
  fullName: string;
  role: PlatformStaffRole;
  status: PlatformStaffStatus;
  invitedBy: string | null;
  invitedAt: string | null;
  activatedAt: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvitePlatformStaffResult extends PlatformStaffMember {
  invitationToken: string;
  invitationExpiresAt: string;
}

export function apiListPlatformStaff(): Promise<PlatformStaffMember[]> {
  return authFetch("/platform/staff");
}

export function apiInvitePlatformStaff(input: {
  email: string;
  fullName: string;
  role: PlatformStaffRole;
}): Promise<InvitePlatformStaffResult> {
  return authFetch("/platform/staff", { method: "POST", body: JSON.stringify(input) });
}

export function apiSetPlatformStaffRole(
  id: string, role: PlatformStaffRole,
): Promise<PlatformStaffMember> {
  return authFetch(`/platform/staff/${encodeURIComponent(id)}/role`, {
    method: "PUT", body: JSON.stringify({ role }),
  });
}

export function apiSuspendPlatformStaff(id: string, reason: string): Promise<PlatformStaffMember> {
  return authFetch(`/platform/staff/${encodeURIComponent(id)}/suspend`, {
    method: "POST", body: JSON.stringify({ reason }),
  });
}

export function apiReinstatePlatformStaff(id: string): Promise<PlatformStaffMember> {
  return authFetch(`/platform/staff/${encodeURIComponent(id)}/reinstate`, { method: "POST" });
}

/** Only somebody who never signed in. Anyone who has is suspended instead. */
export function apiDeletePlatformStaff(id: string): Promise<void> {
  return authFetch(`/platform/staff/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** A new token for an invited staff member who lost theirs. The old token stops working. */
export function apiResendPlatformStaffInvitation(id: string): Promise<ResendInvitationResult> {
  return authFetch(`/platform/staff/${encodeURIComponent(id)}/resend-invitation`, { method: "POST" });
}

// ------------------------------------------------------------------------- plants

/**
 * A site inside the signed-in client's own account — GET /equipment/plants and
 * friends. There is no cross-tenant equivalent: a plant belongs to whichever
 * tenant is asking, decided by the session, never by a client picker. Master
 * Admin has no plants of their own to see or manage here.
 */
/** A single outer ring, no holes — all this app's boundary editor produces or needs. */
export interface GeoJsonPolygon {
  type: "Polygon";
  /** [longitude, latitude] pairs. The first ring must close: its last position repeats its first. */
  coordinates: [number, number][][];
}

export interface Plant {
  id: string;
  code: string;
  name: string;
  address: string | null;
  siteArea: string | null;
  capacity: string | null;
  projectType: string | null;
  operationalStatus: string | null;
  description: string | null;
  status: "active" | "retired";
  sourceSystem: string | null;
  externalId: string | null;
  boundary: GeoJsonPolygon | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlantInput {
  code: string;
  name: string;
  address?: string;
  siteArea?: string;
  capacity?: string;
  projectType?: string;
  operationalStatus?: string;
  description?: string;
}

export function apiListPlants(includeRetired = true, tenantId?: string): Promise<Plant[]> {
  const params = new URLSearchParams();
  if (includeRetired) params.set("includeRetired", "true");
  if (tenantId) params.set("tenantId", tenantId);
  const qs = params.toString();
  return authFetch(`/equipment/plants${qs ? `?${qs}` : ""}`);
}

export function apiCreatePlant(input: PlantInput): Promise<Plant> {
  return authFetch("/equipment/plants", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function apiUpdatePlant(
  id: string,
  input: Partial<PlantInput>,
): Promise<Plant> {
  return authFetch(`/equipment/plants/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function apiRetirePlant(id: string): Promise<Plant> {
  return authFetch(`/equipment/plants/${encodeURIComponent(id)}/retire`, {
    method: "POST",
  });
}

export function apiReopenPlant(id: string): Promise<Plant> {
  return authFetch(`/equipment/plants/${encodeURIComponent(id)}/reopen`, {
    method: "POST",
  });
}

/** Set or clear (pass null) a site's geofence. Validated server-side — a
 *  refused shape comes back as the exact rule it broke, not a generic error. */
export function apiSetPlantBoundary(id: string, boundary: GeoJsonPolygon | null): Promise<Plant> {
  return authFetch(`/equipment/plants/${encodeURIComponent(id)}/boundary`, {
    method: "PUT",
    body: JSON.stringify({ boundary }),
  });
}

export interface ImportResult {
  imported: number;
  alreadyKnown: number;
  unplaced: number;
}

/** Adopt every machine the legacy platform's mirror already knows about for
 *  this source system, once. Synchronous, no review step — same tenant only. */
export function apiImportEquipmentFromMirror(sourceSystem: string): Promise<ImportResult> {
  return authFetch(`/equipment/import/${encodeURIComponent(sourceSystem)}`, {
    method: "POST",
  });
}

// ---------------------------------------------------------------- equipment classes

/**
 * The real "Category" — platform-owned template classes authored by Things
 * Alive (POST/PATCH /catalog/equipment-classes and friends). Nothing here is
 * tenant data: one row describes a class of machine for every account that
 * owns one, which is why there is no client picker anywhere in this file —
 * the mock's per-client "Category" never had a real equivalent.
 */
export interface ExpectedSignal {
  signal: string;
  unit: string | null;
  required: boolean;
  description?: string;
}

export interface FailureMode {
  code: string;
  name: string;
  symptom: string;
  signals: string[];
}

export interface EquipmentClass {
  id: string;
  slug: string;
  version: number;
  name: string;
  description: string | null;
  category: string | null;
  expectedSignals: ExpectedSignal[];
  failureModes: FailureMode[];
  defaultThresholds: Record<string, unknown>;
  status: "draft" | "published" | "retired";
  publishedAt: string | null;
  updatedAt: string;
  /** Exists for the demo tenant only; only the demo seeder may grant it. */
  seedOnly: boolean;
}

export interface EquipmentClassInput {
  name?: string;
  description?: string;
  category?: string;
  expectedSignals?: ExpectedSignal[];
  failureModes?: FailureMode[];
  defaultThresholds?: Record<string, unknown>;
}

/** Every version, draft and published — Things Alive only. What CategoryView lists. */
export function apiListEquipmentClasses(): Promise<EquipmentClass[]> {
  return authFetch("/catalog/authoring/equipment-classes");
}

/**
 * Published classes this tenant is entitled to (`/catalog/equipment-classes`,
 * `catalog.read`) — the list a client picks from when registering a machine.
 * Narrowed by the entitlement join server-side, not by role.
 */
export function apiListMyEquipmentClasses(): Promise<EquipmentClass[]> {
  return authFetch("/catalog/equipment-classes");
}

export function apiCreateEquipmentClass(
  slug: string,
  input: EquipmentClassInput,
): Promise<EquipmentClass> {
  return authFetch("/catalog/equipment-classes", {
    method: "POST",
    body: JSON.stringify({ slug, ...input }),
  });
}

/** Edits the working draft, forking one from the published version if none exists yet. */
export function apiUpdateEquipmentClass(
  slug: string,
  input: EquipmentClassInput,
): Promise<EquipmentClass> {
  return authFetch(`/catalog/equipment-classes/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/** Refused with no expected signals — a class declaring none blocks every scenario on it. */
export function apiPublishEquipmentClass(
  slug: string,
): Promise<EquipmentClass> {
  return authFetch(
    `/catalog/equipment-classes/${encodeURIComponent(slug)}/publish`,
    { method: "POST" },
  );
}

/** Stops offering it; accounts that already have a copy keep running it. */
/** Publishes the newest retired version again. Refused while any version is published. */
export function apiUnretireEquipmentClass(slug: string): Promise<EquipmentClass> {
  return authFetch(`/catalog/equipment-classes/${encodeURIComponent(slug)}/unretire`, { method: "POST" });
}

export function apiRetireEquipmentClass(
  slug: string,
): Promise<EquipmentClass[]> {
  return authFetch(
    `/catalog/equipment-classes/${encodeURIComponent(slug)}/retire`,
    { method: "POST" },
  );
}

// ------------------------------------------------------------------ entitlements

/**
 * Which equipment classes a tenant has been granted (`/catalog/entitlements`,
 * `entitlement.grant` — master admin only). The commercial boundary: a tenant
 * cannot write its own entitlements, only read the catalog they resolve to.
 * A revoked grant keeps the row rather than deleting it — "existed and was
 * withdrawn" is a different fact from "never existed."
 */
export interface Entitlement {
  id: string;
  tenantId: string;
  equipmentClassSlug: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  note: string | null;
}

/** Every grant across every tenant — filter client-side by tenantId. */
export function apiListEntitlements(): Promise<Entitlement[]> {
  return authFetch("/catalog/entitlements");
}

/** Re-granting a revoked (or re-granting the same) class reuses the one row per
 *  (tenant, class) — the backend enforces that uniqueness, not this call. */
export function apiGrantEntitlement(
  tenantId: string,
  equipmentClassSlug: string,
  note?: string,
): Promise<Entitlement> {
  return authFetch("/catalog/entitlements", {
    method: "POST",
    body: JSON.stringify({ tenantId, equipmentClassSlug, note }),
  });
}

export function apiRevokeEntitlement(id: string): Promise<Entitlement> {
  return authFetch(`/catalog/entitlements/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
  });
}

// --------------------------------------------------------------------- equipment

export type ServiceTier = "basic" | "standard" | "advanced" | "full";

/**
 * A machine in the client's own register (`/equipment`, `equipment.write`).
 * `sourceSystem`/`externalId` are the real identity — assigned server-side
 * (`externalId` is just the `code` sent on create), never supplied by the caller.
 */
export interface EquipmentProfile {
  id: string;
  tenantId: string;
  sourceSystem: string;
  externalId: string;
  equipmentClassSlug: string | null;
  classVersion: number | null;
  tier: ServiceTier;
  commissionedAt: string | null;
  serviceIntervalHours: number | null;
  readiness: Record<string, unknown>;
  origin: "mirrored" | "client";
  status: "active" | "retired";
  name: string | null;
  manufacturer: string | null;
  modelNumber: string | null;
  serialNumber: string | null;
  description: string | null;
  plantId: string | null;
  updatedAt: string;
}

export interface EquipmentInput {
  /** Becomes `externalId` — part of the machine's identity, not changed later. */
  code: string;
  name: string;
  manufacturer?: string;
  modelNumber?: string;
  serialNumber?: string;
  description?: string;
  plantId?: string;
  equipmentClassSlug?: string;
  tier?: ServiceTier;
  commissionedAt?: string;
  serviceIntervalHours?: number;
  /** Master Admin only — acts on this account instead of their own (they have none). */
  tenantId?: string;
}

export function apiListEquipment(
  filters: { plantId?: string; includeRetired?: boolean; tenantId?: string } = {},
): Promise<EquipmentProfile[]> {
  const params = new URLSearchParams();
  if (filters.plantId) params.set("plantId", filters.plantId);
  if (filters.includeRetired) params.set("includeRetired", "true");
  if (filters.tenantId) params.set("tenantId", filters.tenantId);
  const qs = params.toString();
  return authFetch(`/equipment${qs ? `?${qs}` : ""}`);
}

/** Every account's equipment register in one read (`GET /equipment/all`) — Master
 *  Admin only, for the Equipment sidebar page. Each row still carries its own
 *  `tenantId`; resolve the client name from the already-fetched accounts list,
 *  the same way the device pool does. */
export function apiListAllEquipment(): Promise<EquipmentProfile[]> {
  return authFetch("/equipment/all");
}

export function apiCreateEquipment(input: EquipmentInput): Promise<EquipmentProfile> {
  return authFetch("/equipment", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Descriptive fields only — the validator rejects anything else on this route,
 *  `plantId` included. Placement has its own route (`apiMoveEquipment`) because
 *  moving a machine has consequences (who can see it) a plain edit does not. */
export function apiUpdateEquipment(
  sourceSystem: string,
  externalId: string,
  input: Partial<Omit<EquipmentInput, "code" | "plantId">>,
): Promise<EquipmentProfile> {
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

/** Move a machine to another site (or null to take it off site). Requires a
 *  reason — this is the edit that changes who can see the asset. `tenantId` is
 *  Master Admin's own override. */
export function apiMoveEquipment(
  sourceSystem: string,
  externalId: string,
  toPlantId: string | null,
  reason: string,
  tenantId?: string,
): Promise<EquipmentProfile> {
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/move`,
    { method: "POST", body: JSON.stringify({ toPlantId, reason, tenantId }) },
  );
}

/** Where a machine has been, and who moved it (`/equipment/:sourceSystem/:externalId/placements`,
 *  `catalog.read`) — oldest first. `fromPlantId`/`toPlantId` are null for "no site". */
export interface EquipmentPlacementEvent {
  id: string;
  sourceSystem: string;
  externalId: string;
  fromPlantId: string | null;
  toPlantId: string | null;
  reason: string | null;
  actorUserId: string;
  at: string;
}

export function apiGetEquipmentPlacementHistory(
  sourceSystem: string,
  externalId: string,
  tenantId?: string,
): Promise<EquipmentPlacementEvent[]> {
  const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/placements${qs}`,
  );
}

/** There is no hard delete — a machine leaves its site and stops counting as
 *  active, but the row (and its placement/binding history) stays. `tenantId` is
 *  Master Admin's own override. */
export function apiRetireEquipment(
  sourceSystem: string,
  externalId: string,
  reason: string,
  tenantId?: string,
): Promise<EquipmentProfile> {
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/retire`,
    { method: "POST", body: JSON.stringify({ reason, tenantId }) },
  );
}

// -------------------------------------------------------------------- scenarios

/**
 * A prediction scenario on a class (POST/PATCH /catalog/scenarios and friends,
 * `catalog.write` — Things Alive only). Same draft/publish shape as EquipmentClass:
 * immutable once published, a new edit forks a new draft version.
 */
export type ScenarioParameter = {
  key: string;
  label: string;
  type: "number" | "duration" | "boolean" | "enum";
  default: unknown;
  min?: number;
  max?: number;
  options?: string[];
  unit?: string;
};

export interface Scenario {
  id: string;
  slug: string;
  version: number;
  equipmentClassSlug: string;
  name: string;
  description: string | null;
  severity: "none" | "low" | "medium" | "high" | "critical";
  tier: 1 | 2 | 3;
  requiredSignals: string[];
  minimumHistoryDays: number;
  parameters: ScenarioParameter[];
  status: "draft" | "published" | "retired";
  publishedAt: string | null;
  updatedAt: string;
}

export interface ScenarioInput {
  name?: string;
  description?: string;
  severity?: Scenario["severity"];
  tier?: Scenario["tier"];
  requiredSignals?: string[];
  minimumHistoryDays?: number;
  parameters?: ScenarioParameter[];
}

/** Every version, draft and published, across every class — what the authoring screen lists. */
export function apiListAuthoringScenarios(
  equipmentClassSlug?: string,
): Promise<Scenario[]> {
  const query = equipmentClassSlug
    ? `?equipmentClassSlug=${encodeURIComponent(equipmentClassSlug)}`
    : "";
  return authFetch(`/catalog/authoring/scenarios${query}`);
}

export function apiCreateScenario(
  slug: string,
  equipmentClassSlug: string,
  input: ScenarioInput,
): Promise<Scenario> {
  return authFetch("/catalog/scenarios", {
    method: "POST",
    body: JSON.stringify({ slug, equipmentClassSlug, ...input }),
  });
}

/** Edits the working draft, forking one from the published version if none exists yet. */
export function apiUpdateScenario(
  slug: string,
  input: ScenarioInput,
): Promise<Scenario> {
  return authFetch(`/catalog/scenarios/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function apiPublishScenario(slug: string): Promise<Scenario> {
  return authFetch(`/catalog/scenarios/${encodeURIComponent(slug)}/publish`, {
    method: "POST",
  });
}

// ------------------------------------------------------------------- signal aliases

/**
 * Which upstream spelling of a measurement maps to its canonical signal name
 * (`catalog.write` — Things Alive only). Platform-owned, like the rest of the
 * catalog: an alias is a fact about a device family, not about a customer.
 */
export interface SignalAlias {
  id: string;
  sourceSystem: string;
  alias: string;
  canonical: string;
  unit: string | null;
  note: string | null;
}

export interface SignalAliasInput {
  sourceSystem: string;
  alias: string;
  canonical: string;
  unit?: string;
  note?: string;
}

export function apiListSignalAliases(): Promise<SignalAlias[]> {
  return authFetch(`/catalog/authoring/signal-aliases`);
}

/** Create-or-update, keyed by (sourceSystem, alias) — there is no separate update route. */
export function apiUpsertSignalAlias(input: SignalAliasInput): Promise<SignalAlias> {
  return authFetch(`/catalog/signal-aliases`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function apiDeleteSignalAlias(sourceSystem: string, alias: string): Promise<void> {
  return authFetch(`/catalog/signal-aliases/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(alias)}`, {
    method: "DELETE",
  });
}

// -------------------------------------------------------------- alert rule templates

/**
 * What Things Alive knows is worth alerting on, for a class (POST/PATCH
 * /catalog/alert-templates and friends, `catalog.write` — Things Alive only).
 * Granting the class copies these into the account as the client's own `AlertRule`
 * rows, which the client then owns and edits — this file has no route for that copy,
 * only for the template it was copied from.
 *
 * `fuel-loss` needs a live GPS fix this authoring context never has, so it stays out
 * of the picker. `chain-origin` now has somewhere to get a chain from — the Causal
 * Chains tab alongside this one on the same class — so it is modelled like the rest:
 * `atLeast` and an optional `stageSignal`/`chainSlug`, both left to "watch everything"
 * when unset, the same way `prediction-severity`'s `clientScenarioSlug` already does.
 */
export type AlertTrigger =
  | "prediction-severity"
  | "signal-threshold"
  | "no-telemetry"
  | "fuel-loss"
  | "chain-origin";

export interface PredictionSeverityParams {
  atLeast: "none" | "low" | "medium" | "high" | "critical";
  clientScenarioSlug?: string | null;
}

export interface SignalThresholdParams {
  signal: string;
  max?: number | null;
  min?: number | null;
  /** Tenant alert rules only — unsupported in class-level template authoring, which
   *  has no live machine to default these against. */
  lookbackReadings?: number;
  requiredBreaches?: number;
}

/** Fires on where a causal chain says a fault entered — not just that a number is
 *  high, but that it is high because something upstream explains it. */
export interface ChainOriginParams {
  atLeast: "warning" | "critical";
  /** Left unset to watch every chain bound to the machine's class. */
  chainSlug?: string | null;
  /** Restrict to a fault entering at one particular stage. */
  stageSignal?: string | null;
}

export type AlertParams =
  | PredictionSeverityParams
  | SignalThresholdParams
  | ChainOriginParams
  | Record<string, unknown>;

export interface AlertRuleTemplate {
  id: string;
  slug: string;
  version: number;
  equipmentClassSlug: string;
  name: string;
  description: string | null;
  trigger: AlertTrigger;
  params: AlertParams;
  severity: "none" | "low" | "medium" | "high" | "critical";
  enabledOnCopy: boolean;
  status: "draft" | "published" | "retired";
  publishedAt: string | null;
  createdAt: string;
}

export interface AlertRuleTemplateInput {
  name?: string;
  description?: string;
  trigger?: AlertTrigger;
  params?: AlertParams;
  severity?: AlertRuleTemplate["severity"];
  enabledOnCopy?: boolean;
}

/** Every version, draft and published, across every class. */
export function apiListAuthoringAlertTemplates(
  equipmentClassSlug?: string,
): Promise<AlertRuleTemplate[]> {
  const query = equipmentClassSlug
    ? `?equipmentClassSlug=${encodeURIComponent(equipmentClassSlug)}`
    : "";
  return authFetch(`/catalog/authoring/alert-templates${query}`);
}

export function apiCreateAlertTemplate(
  slug: string,
  equipmentClassSlug: string,
  input: AlertRuleTemplateInput,
): Promise<AlertRuleTemplate> {
  return authFetch("/catalog/alert-templates", {
    method: "POST",
    body: JSON.stringify({ slug, equipmentClassSlug, ...input }),
  });
}

/** Edits the working draft, forking one from the published version if none exists yet. */
export function apiUpdateAlertTemplate(
  slug: string,
  input: AlertRuleTemplateInput,
): Promise<AlertRuleTemplate> {
  return authFetch(`/catalog/alert-templates/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function apiPublishAlertTemplate(
  slug: string,
): Promise<AlertRuleTemplate> {
  return authFetch(
    `/catalog/alert-templates/${encodeURIComponent(slug)}/publish`,
    { method: "POST" },
  );
}

/** Stops shipping it; copies already in accounts keep running. */
export function apiRetireAlertTemplate(
  slug: string,
): Promise<AlertRuleTemplate> {
  return authFetch(
    `/catalog/alert-templates/${encodeURIComponent(slug)}/retire`,
    { method: "POST" },
  );
}

// ------------------------------------------------------------------- causal chains

/**
 * The physical layer behind a `chain-origin` alert and a diagnosis (`catalog.write`
 * to author, Things Alive only — a chain is a claim about how a kind of machine
 * behaves, part of what Things Alive sells). Each stage predicts one signal from its
 * own upstream drivers; a stage whose residual is off its own curve is where a fault
 * entered, which is a different question from "is this number high".
 */
export type ChainDirection = "above" | "below" | "either";

export interface ChainDriver {
  /** An upstream stage's signal, or an exogenous input like load or ambient. */
  signal: string;
  /** Units of this stage per unit of the driver. */
  coefficient: number;
  /** How long the driver takes to show up here. */
  lagSeconds?: number;
}

export interface ChainNode {
  /** The signal this stage predicts. */
  signal: string;
  label?: string;
  /** Expected value when every driver reads zero. */
  intercept: number;
  drivers: ChainDriver[];
  /** Residual magnitude at which this stage is off its curve. */
  warnAbove: number;
  criticalAbove: number;
  direction?: ChainDirection;
}

export interface CausalChain {
  id: string;
  slug: string;
  version: number;
  equipmentClassSlug: string;
  scenarioSlug: string | null;
  name: string;
  description: string | null;
  outcome: string | null;
  nodes: ChainNode[];
  alignmentSeconds: number | null;
  provenance: string | null;
  status: "draft" | "published" | "retired";
  publishedAt: string | null;
  createdAt: string;
}

export interface CausalChainInput {
  equipmentClassSlug: string;
  scenarioSlug?: string;
  name: string;
  description?: string;
  outcome?: string;
  nodes: ChainNode[];
  alignmentSeconds?: number;
  provenance?: string;
}

/** Published chains for a class — what a `chain-origin` rule actually runs against. */
export function apiListCausalChains(equipmentClassSlug: string): Promise<CausalChain[]> {
  return authFetch(`/intelligence/chains?equipmentClassSlug=${encodeURIComponent(equipmentClassSlug)}`);
}

/** Every version, draft and published, across one class. */
export function apiListAuthoringCausalChains(equipmentClassSlug?: string): Promise<CausalChain[]> {
  const query = equipmentClassSlug ? `?equipmentClassSlug=${encodeURIComponent(equipmentClassSlug)}` : "";
  return authFetch(`/intelligence/authoring/chains${query}`);
}

/** Validated whole — cycles, self-driving stages and unreachable thresholds are the
 *  database's to catch, not this form's. */
export function apiDraftCausalChain(slug: string, input: CausalChainInput): Promise<CausalChain> {
  return authFetch(`/intelligence/chains/${encodeURIComponent(slug)}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function apiPublishCausalChain(slug: string): Promise<CausalChain> {
  return authFetch(`/intelligence/chains/${encodeURIComponent(slug)}/publish`, {
    method: "POST",
  });
}

// ---------------------------------------------------------------- named formulas

/**
 * Physics, authored once and shared by every equipment class that needs it
 * (`/platform/catalog/named-formulas`, `catalog.write` to author, `catalog.publish`
 * to publish — Things Alive only). Written against roles (`fuel_rate / power_output`),
 * never signal names directly; a class binds each role to one of its own signals
 * separately. Immutable once published, same as an equipment class.
 */
export interface NamedFormulaRoleInput {
  role: string;
  dimension: string;
  description?: string;
  expectedParameters?: string[];
}

export interface NamedFormula {
  id: string;
  slug: string;
  version: number;
  name: string;
  description: string | null;
  category: string | null;
  expression: string;
  inputs: NamedFormulaRoleInput[];
  resultDimension: string | null;
  resultKind: "scalar" | "series" | null;
  status: "draft" | "published";
  publishedAt: string | null;
  createdBy: string | null;
  updatedAt: string;
  resultUnit: string | null;
}

export interface NamedFormulaInput {
  name?: string;
  description?: string;
  category?: string;
  expression?: string;
  inputs?: NamedFormulaRoleInput[];
  resultDimension?: string;
  resultKind?: "scalar" | "series";
}

export function apiListNamedFormulas(status?: string, category?: string): Promise<NamedFormula[]> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (category) params.set("category", category);
  const qs = params.toString();
  return authFetch(`/platform/catalog/named-formulas${qs ? `?${qs}` : ""}`);
}

export function apiGetNamedFormulaVersions(slug: string): Promise<NamedFormula[]> {
  return authFetch(`/platform/catalog/named-formulas/${encodeURIComponent(slug)}`);
}

export function apiCreateNamedFormula(slug: string, input: NamedFormulaInput): Promise<NamedFormula> {
  return authFetch("/platform/catalog/named-formulas", {
    method: "POST",
    body: JSON.stringify({ slug, ...input }),
  });
}

/** Refused once that version is published. */
export function apiEditNamedFormula(slug: string, version: number, input: NamedFormulaInput): Promise<NamedFormula> {
  return authFetch(`/platform/catalog/named-formulas/${encodeURIComponent(slug)}/${version}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/** Compiles and publishes. Immutable from this point on. */
export function apiPublishNamedFormula(slug: string, version: number): Promise<NamedFormula> {
  return authFetch(`/platform/catalog/named-formulas/${encodeURIComponent(slug)}/${version}/publish`, {
    method: "POST",
  });
}

// ------------------------------------------------------------------ catalog import

/**
 * The Excel catalog import (`/platform/catalog/*`, `catalog.write` — Things Alive
 * only). Bulk-authors the same classes/scenarios/alert-templates the screens above
 * edit one at a time: upload a workbook, review the dry-run diff, apply it. A batch is
 * immutable once uploaded — fixing a mistake means uploading a new workbook, not
 * editing this one.
 */
export type CatalogImportBatchStatus =
  | "parsed"
  | "validated"
  | "rejected"
  | "applied";

export interface CatalogImportBatch {
  id: string;
  filename: string;
  templateVersion: string;
  uploadedBy: string;
  status: CatalogImportBatchStatus;
  summary: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  appliedAt: string | null;
  appliedBy: string | null;
}

export type ClassDiffAction = "create" | "new_version" | "unchanged";

export interface ClassDiffEntry {
  slug: string;
  action: ClassDiffAction;
  countsBySheet: Record<string, number>;
  /** Apply refuses a class carrying these unless acknowledgeWarnings is sent. */
  warnings?: ('incomplete_class' | 'content_regression')[];
}

export interface RejectedImportRow {
  sheet: string;
  rowNumber: number;
  reason: string;
}

/** A sensor the workbook references that the catalog does not have yet (task QIMP5). */
export interface ProposedSensor {
  slug: string;
  name: string;
  category: string | null;
  parameterKey: string | null;
  canonicalUnit: string | null;
  proposedByRows: number[];
  usedByClasses: string[];
}

/** A category one or more proposed sensors need, that the catalog also lacks. */
export interface ProposedCategory {
  slug: string;
  name: string;
  proposedBySensors: string[];
}

export interface CatalogImportDiff {
  batchId: string;
  status: string;
  classes: ClassDiffEntry[];
  sensorCapabilities: { valid: number; invalid: number };
  rejectedRows: RejectedImportRow[];
  partialApplyNote: string;
  proposedSensors: ProposedSensor[];
  proposedCategories: ProposedCategory[];
}

export interface ClassApplyResult {
  action: ClassDiffAction;
  version: number;
  created: Record<string, number>;
  /** Draft alert templates made from the signal sheet's limits. */
  draftedAlertTemplates?: number;
}

export interface CatalogImportApplySummary {
  classes: Record<string, ClassApplyResult>;
  sensorCapabilities: { created: number; skipped: number; parametersAdded?: number };
}

/** Uploaded, parsed and validated in one step. Rejects outright on a malformed workbook. */
export async function apiUploadCatalogImport(
  file: File,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await authFetchRaw("/platform/catalog/imports", {
    method: "POST",
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(
      body?.error?.message ?? "Could not upload the workbook.",
      res.status,
    );
  return body;
}

export function apiListCatalogImports(): Promise<CatalogImportBatch[]> {
  return authFetch("/platform/catalog/imports");
}

/** The dry-run diff: what applying this batch would change. */
export function apiGetCatalogImportDiff(
  id: string,
): Promise<CatalogImportDiff> {
  return authFetch(`/platform/catalog/imports/${encodeURIComponent(id)}`);
}

export function apiApplyCatalogImport(
  id: string,
  acknowledgeWarnings = false,
): Promise<CatalogImportApplySummary> {
  return authFetch(
    `/platform/catalog/imports/${encodeURIComponent(id)}/apply`,
    { method: "POST", body: JSON.stringify({ acknowledgeWarnings }) },
  );
}

/** Discards a batch that has not been applied yet. Refused once a batch is applied — its content is the catalog's own provenance record by then (task QIMP4). */
export async function apiDiscardCatalogImport(id: string): Promise<void> {
  await authFetch(`/platform/catalog/imports/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export interface SensorReviewSelection {
  /** Category slugs to create. */
  approveCategories?: { slug: string }[];
  /** Sensor slugs to create — each one's category must already exist or be named in `approveCategories` in the same call. */
  approve?: { slug: string }[];
  /** Sensor or category slugs to drop from the proposal list without creating anything. */
  dismiss?: { slug: string }[];
}

/** Approves or dismisses the sensors/categories a batch proposes, then re-validates and returns the recomputed diff — no re-upload needed (task QIMP5). */
export function apiReviewCatalogImportSensors(
  id: string,
  selection: SensorReviewSelection,
): Promise<CatalogImportDiff> {
  return authFetch(
    `/platform/catalog/imports/${encodeURIComponent(id)}/sensors`,
    { method: "POST", body: JSON.stringify(selection) },
  );
}

/** The current workbook template, ready to fill in and re-upload. */
export async function apiDownloadCatalogTemplate(): Promise<Blob> {
  const res = await authFetchRaw("/platform/catalog/template");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      body?.error?.message ?? "Could not download the template.",
      res.status,
    );
  }
  return res.blob();
}

// -------------------------------------------------------------------- device catalog

/**
 * Master Admin's own reference data for wiring a device before it exists
 * (/device-catalog/*, `device-catalog.write` — master admin only). Flat master data,
 * no draft/publish lifecycle: a sensor or tool mapping is edited in place, never
 * versioned or retired.
 */
export interface SensorCategory {
  id: string;
  name: string;
  retiredAt: string | null;
  retiredBy: string | null;
}

export interface SensorParameterSpec {
  parameter: string;
  unit: string;
  /** null on a sensor created from a catalog import until someone sets the range. */
  min: number | null;
  max: number | null;
  normalRange: string;
  notes?: string;
}

export interface Sensor {
  id: string;
  sensorName: string;
  slug: string;
  categoryId: string | null;
  description: string | null;
  protocol: string | null;
  parameterSpecs: SensorParameterSpec[];
  retiredAt: string | null;
  retiredBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SensorInput {
  sensorName?: string;
  categoryId?: string;
  description?: string;
  protocol?: string;
  parameterSpecs?: SensorParameterSpec[];
}

export function apiListSensorCategories(includeRetired = false): Promise<SensorCategory[]> {
  return authFetch(`/device-catalog/categories${includeRetired ? "?includeRetired=true" : ""}`);
}

export function apiCreateSensorCategory(name: string): Promise<SensorCategory> {
  return authFetch("/device-catalog/categories", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function apiRetireSensorCategory(id: string): Promise<SensorCategory> {
  return authFetch(`/device-catalog/categories/${encodeURIComponent(id)}/retire`, { method: "POST" });
}

/** Sensors keep the category: they hold it by id. 409 when another category has the name. */
export function apiRenameSensorCategory(id: string, name: string): Promise<SensorCategory> {
  return authFetch(`/device-catalog/categories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function apiUnretireSensorCategory(id: string): Promise<SensorCategory> {
  return authFetch(`/device-catalog/categories/${encodeURIComponent(id)}/unretire`, { method: "POST" });
}

export function apiDeleteSensorCategory(id: string): Promise<void> {
  return authFetch(`/device-catalog/categories/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function apiListSensors(includeRetired = false): Promise<Sensor[]> {
  return authFetch(`/device-catalog/sensors${includeRetired ? "?includeRetired=true" : ""}`);
}

export function apiCreateSensor(input: SensorInput): Promise<Sensor> {
  return authFetch("/device-catalog/sensors", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function apiUpdateSensor(
  id: string,
  input: SensorInput,
): Promise<Sensor> {
  return authFetch(`/device-catalog/sensors/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function apiRetireSensor(id: string): Promise<Sensor> {
  return authFetch(`/device-catalog/sensors/${encodeURIComponent(id)}/retire`, { method: "POST" });
}

export function apiUnretireSensor(id: string): Promise<Sensor> {
  return authFetch(`/device-catalog/sensors/${encodeURIComponent(id)}/unretire`, { method: "POST" });
}

export function apiDeleteSensor(id: string): Promise<void> {
  return authFetch(`/device-catalog/sensors/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** A sensor mapped onto a tool profile, resolved to its name — never stored, only read. */
export interface ResolvedMappedSensor {
  sensorId: string;
  sensorName: string;
  parameters: string[];
}

export interface ToolMapping {
  id: string;
  toolName: string;
  /** The industry type's name, resolved from `industryTypeId`; null when none is set. */
  industryType: string | null;
  industryTypeId: string | null;
  /** Free text typed before industry types existed, frozen; shown until re-matched. */
  industryTypeLegacy: string | null;
  protocol: string | null;
  mappedSensors: ResolvedMappedSensor[];
  createdAt: string;
  updatedAt: string;
}

export interface ToolMappingInput {
  toolName?: string;
  /** An active industry type's id; null clears it. Preferred over `industryType` text. */
  industryTypeId?: string | null;
  industryType?: string;
  protocol?: string;
  mappedSensors?: { sensorId: string; parameters: string[] }[];
}

// ------------------------------------------------------------------ industry types

/**
 * What industry a tool mapping is for (`/device-catalog/industry-types`,
 * `device-catalog.write`). Global reference data owned by Things Alive. Inactive hides
 * a type from the tool-mapping picker; mappings already pointing at it keep it.
 */
export type IndustryTypeStatus = "active" | "inactive";

export interface IndustryType {
  id: string;
  name: string;
  /** 2–10 uppercase letters or digits, unique. */
  code: string;
  status: IndustryTypeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface IndustryTypeInput {
  name?: string;
  code?: string;
  status?: IndustryTypeStatus;
}

/** Pre-industry-type text no active type matches yet, with how many mappings carry it. */
export interface UnmatchedIndustry {
  text: string;
  mappings: number;
}

export function apiListIndustryTypes(status?: IndustryTypeStatus): Promise<IndustryType[]> {
  return authFetch(`/device-catalog/industry-types${status ? `?status=${status}` : ""}`);
}

export function apiCreateIndustryType(input: IndustryTypeInput & { name: string; code: string }): Promise<IndustryType> {
  return authFetch("/device-catalog/industry-types", { method: "POST", body: JSON.stringify(input) });
}

export function apiUpdateIndustryType(id: string, input: IndustryTypeInput): Promise<IndustryType> {
  return authFetch(`/device-catalog/industry-types/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/** Refused (409, naming the count) while any tool mapping uses the type. */
export function apiDeleteIndustryType(id: string): Promise<void> {
  return authFetch(`/device-catalog/industry-types/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function apiListUnmatchedIndustries(): Promise<UnmatchedIndustry[]> {
  return authFetch("/device-catalog/tool-mappings/unmatched-industries");
}

/** Matches unmatched mappings to the active types that now exist; never moves a set one. */
export function apiRematchIndustries(): Promise<{ matched: number; unmatched: number }> {
  return authFetch("/device-catalog/tool-mappings/unmatched-industries/rematch", { method: "POST" });
}

export function apiListToolMappings(): Promise<ToolMapping[]> {
  return authFetch("/device-catalog/tool-mappings");
}

export function apiCreateToolMapping(
  input: ToolMappingInput,
): Promise<ToolMapping> {
  return authFetch("/device-catalog/tool-mappings", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Refused (409) while any device is still registered with this mapping. */
export function apiDeleteToolMapping(id: string): Promise<void> {
  return authFetch(`/device-catalog/tool-mappings/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function apiUpdateToolMapping(
  id: string,
  input: ToolMappingInput,
): Promise<ToolMapping> {
  return authFetch(`/device-catalog/tool-mappings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

// ------------------------------------------------------------------- signal states

/**
 * What a categorical signal's codes mean, e.g. `utilization_status`: 0=off, 1=idle,
 * 2=working (`device-catalog.read`/`.write` — platform reference data).
 */
export interface SignalStateVocabEntry {
  measurementRole: string;
  state: string;
  code: number;
  updatedBy: string | null;
  updatedAt: string;
}

export interface SignalStateCode {
  state: string;
  code: number;
}

export function apiListSignalStates(role?: string): Promise<SignalStateVocabEntry[]> {
  const qs = role ? `?role=${encodeURIComponent(role)}` : "";
  return authFetch(`/device-catalog/signal-states${qs}`);
}

/** Replaces a role's whole vocabulary — there is no per-state edit, only a full swap. */
export function apiReplaceSignalStates(role: string, states: SignalStateCode[]): Promise<SignalStateVocabEntry[]> {
  return authFetch(`/device-catalog/signal-states/${encodeURIComponent(role)}`, {
    method: "PUT",
    body: JSON.stringify({ states }),
  });
}

// --------------------------------------------------------------------- device pool

/**
 * The device pool (/inventory/*, `device.manage` — master admin only). Register
 * brings stock in; assign hands a batch to one account. Plant/equipment placement is
 * the client's own act (device.claim), not represented here.
 */
export interface PooledDevice {
  id: string;
  imei: string;
  tenantId: string | null;
  state: "in-stock" | "assigned" | "retired";
  model: string | null;
  batchRef: string | null;
  toolMappingId: string | null;
  toolMappingName: string | null;
  receivedAt: string | null;
  assignedAt: string | null;
  notes: string | null;
}

export interface RegisterDeviceInput {
  imei: string;
  model?: string;
  toolMappingId?: string;
  batchRef?: string;
  notes?: string;
}

export function apiListDevicePool(
  filters: {
    state?: PooledDevice["state"];
    tenantId?: string;
    unassignedOnly?: boolean;
  } = {},
): Promise<PooledDevice[]> {
  const params = new URLSearchParams();
  if (filters.state) params.set("state", filters.state);
  if (filters.tenantId) params.set("tenantId", filters.tenantId);
  if (filters.unassignedOnly) params.set("unassignedOnly", "true");
  const query = params.toString();
  return authFetch(`/inventory/pool${query ? `?${query}` : ""}`);
}

export type InventoryAction = "register" | "assign" | "release" | "retire" | "return-to-stock" | "claim" | "unclaim";

/** One move in a device's life, across every account it has been in. */
export interface DeviceInventoryEvent {
  id: string;
  imei: string;
  action: InventoryAction;
  fromState: PooledDevice["state"] | null;
  toState: PooledDevice["state"];
  /** The account it went to or came from; null while in stock. */
  tenantId: string | null;
  equipmentExternalId: string | null;
  reason: string | null;
  actorUserId: string;
  actorRoles: string[];
  at: string;
}

/** Oldest first. Things Alive staff only (`device.manage`). */
export function apiGetDeviceHistory(imei: string): Promise<DeviceInventoryEvent[]> {
  return authFetch(`/inventory/history/${encodeURIComponent(imei)}`);
}

export function apiRegisterDevices(
  devices: RegisterDeviceInput[],
): Promise<{ registered: number; alreadyKnown: number }> {
  return authFetch("/inventory/register", {
    method: "POST",
    body: JSON.stringify({ devices }),
  });
}

export type DeviceBatchOutcome =
  | "assigned"
  | "already-in-this-account"
  | "held-elsewhere"
  | "retired"
  | "unknown";

export function apiAssignDevices(
  imeis: string[],
  tenantId: string,
): Promise<{ imei: string; outcome: DeviceBatchOutcome }[]> {
  return authFetch("/inventory/assign", {
    method: "POST",
    body: JSON.stringify({ imeis, tenantId }),
  });
}

export function apiReleaseDevices(
  imeis: string[],
  reason: string,
): Promise<{ imei: string; outcome: DeviceBatchOutcome }[]> {
  return authFetch("/inventory/release", {
    method: "POST",
    body: JSON.stringify({ imeis, reason }),
  });
}

/** Model, batch and notes any time; the tool profile only while the device is in stock.
 *  A field left out is kept; `toolMappingId: null` clears it. */
export function apiUpdateDevice(
  imei: string,
  input: { model?: string | null; toolMappingId?: string | null; batchRef?: string | null; notes?: string | null },
): Promise<PooledDevice> {
  return authFetch(`/inventory/devices/${encodeURIComponent(imei)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function apiRetireDevices(
  imeis: string[],
  reason: string,
): Promise<{ imei: string; outcome: DeviceBatchOutcome }[]> {
  return authFetch("/inventory/retire", {
    method: "POST",
    body: JSON.stringify({ imeis, reason }),
  });
}

export function apiReturnDevicesToStock(
  imeis: string[],
): Promise<{ imei: string; outcome: DeviceBatchOutcome }[]> {
  return authFetch("/inventory/return-to-stock", {
    method: "POST",
    body: JSON.stringify({ imeis }),
  });
}

/** A device in the client's own account (`/inventory/mine`, `device.read`) — fitted
 *  to a machine or not, which is what `equipmentExternalId` tells apart. */
export interface MyDevice {
  id: string;
  imei: string;
  tenantId: string | null;
  state: "in-stock" | "assigned" | "retired";
  model: string | null;
  toolMappingId: string | null;
  batchRef: string | null;
  receivedAt: string | null;
  assignedAt: string | null;
  equipmentExternalId: string | null;
  claimedAt: string | null;
  claimedBy: string | null;
  notes: string | null;
}

export function apiListMyDevices(): Promise<MyDevice[]> {
  return authFetch("/inventory/mine");
}

/** Fit a device already in this account to one of its machines (`device.claim`). */
export function apiClaimDevice(
  imei: string,
  equipmentExternalId: string,
  sourceSystem: string,
): Promise<MyDevice> {
  return authFetch("/inventory/claim", {
    method: "POST",
    body: JSON.stringify({ imei, equipmentExternalId, sourceSystem }),
  });
}

export function apiUnclaimDevice(imei: string, reason?: string): Promise<MyDevice> {
  return authFetch("/inventory/unclaim", {
    method: "POST",
    body: JSON.stringify({ imei, reason }),
  });
}

// ---------------------------------------------------------------- signal bindings

/**
 * Coverage, discovery and binding (`/equipment/:sourceSystem/:externalId/...`,
 * reads behind `catalog.read`, writes behind `equipment.write`) — closes the gap
 * between "a reading arrived" and "this equipment has this signal".
 */
export type SignalBindingOrigin = "physical" | "ecu_derived" | "virtual";
export type SignalBindingStatus = "proposed" | "discovered_unreviewed" | "active" | "superseded" | "rejected";
export type SignalBindingDiscoveredBy = "tool-mapping" | "sensor-map" | "both" | "manual" | "model";
export type MissingReason = "unbound" | "mapping_required" | "stale" | "no_readings";

export interface SignalFreshness {
  staleAfterSeconds: number;
  lastReadingAt: string | null;
  secondsSinceLastReading: number | null;
}

export type CoveredRequirement = {
  measurementRole: string;
  componentScope: string;
  minCount: number;
  activeCount: number;
} & SignalFreshness;

export interface MissingRequirement extends SignalFreshness {
  measurementRole: string;
  componentScope: string;
  minCount: number;
  activeCount: number;
  reason: MissingReason;
}

export interface BlockedLayer {
  layer: string;
  missingInputs: string[];
}

export interface CoverageResult {
  equipment: { sourceSystem: string; externalId: string };
  at: string;
  covered: CoveredRequirement[];
  missing: MissingRequirement[];
  blockedLayers: BlockedLayer[];
}

export interface DiscoveryCandidate {
  signalKey: string;
  measurementRole: string;
  unit: string | null;
  imei: string | null;
  sensorName: string | null;
  sensorId: string | null;
  /** The open binding for this signal from this logger, if any. */
  bindingStatus: 'proposed' | 'active' | null;
}

export interface DiscoveryResult {
  equipment: { sourceSystem: string; externalId: string };
  matched: DiscoveryCandidate[];
  expectedNotMapped: DiscoveryCandidate[];
  mappedNotExpected: DiscoveryCandidate[];
}

export interface SignalBindingVersion {
  id: string;
  tenantId: string;
  sourceSystem: string;
  externalId: string;
  signalKey: string;
  measurementRole: string;
  componentId: string;
  origin: SignalBindingOrigin;
  imei: string | null;
  channel: string | null;
  sensorInstanceId: string | null;
  canonicalUnit: string;
  sourceUnit: string | null;
  validFrom: string;
  validTo: string | null;
  isPrimary: boolean;
  status: SignalBindingStatus;
  discoveredFrom: string | null;
  discoveredBy: SignalBindingDiscoveredBy;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface ProposeOrActivateBindingInput {
  action: "propose" | "activate";
  signalKey: string;
  measurementRole: string;
  componentId?: string;
  origin: SignalBindingOrigin;
  imei?: string;
  channel?: string;
  sensorInstanceId?: string;
  canonicalUnit: string;
  sourceUnit?: string;
  validFrom: string;
  validTo?: string;
  discoveredBy?: SignalBindingDiscoveredBy;
  discoveredFrom?: string;
}

export function apiGetEquipmentCoverage(
  sourceSystem: string,
  externalId: string,
  at?: string,
): Promise<CoverageResult> {
  const qs = at ? `?at=${encodeURIComponent(at)}` : "";
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/coverage${qs}`,
  );
}

export function apiGetBindingDiscovery(
  sourceSystem: string,
  externalId: string,
): Promise<DiscoveryResult> {
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/binding-discovery`,
  );
}

export function apiProposeOrActivateBinding(
  sourceSystem: string,
  externalId: string,
  input: ProposeOrActivateBindingInput,
): Promise<SignalBindingVersion> {
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/bindings`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

// ------------------------------------------------------------------------------ kpis

/**
 * Runtime KPI evaluation for one machine (`/equipment/:sourceSystem/:externalId/kpis`,
 * `catalog.read`). Every KPI the equipment's class declares, each with its own
 * readiness envelope — never a bare number for one that isn't ready to compute.
 */
export type KpiReadiness = "ready" | "blocked" | "not_configured" | "not_available";

export type KpiReason =
  | "unbound" | "stale" | "no_readings" | "mapping_required"
  | "baseline_not_established" | "insufficient_coverage" | "undefined_result"
  | "parameter_not_set" | "site_boundary_not_set" | "no_shift_schedule" | "not_operating"
  | "window_not_resolved" | "formula_not_compiled";

export interface KpiSeriesPoint { t: string; v: number | null }

export interface KpiEnvelope {
  formulaKey: string;
  value: number | KpiSeriesPoint[] | null;
  unit: string;
  resultKind: "scalar" | "series";
  /** null when the formula's own window can't be resolved (e.g. a `shift` window). */
  window: { from: string; to: string } | null;
  readiness: KpiReadiness;
  reason?: KpiReason;
  /** Which client parameters have no value at any scope for this machine — only with `reason: 'parameter_not_set'`. */
  missingParameters?: string[];
  coverage: { expected: number; actual: number; ratio: number };
}

export function apiListEquipmentKpis(sourceSystem: string, externalId: string): Promise<KpiEnvelope[]> {
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/kpis`,
  );
}

/** One KPI over its declared window, or an explicit from/to (both or neither). */
export function apiGetEquipmentKpi(
  sourceSystem: string, externalId: string, formulaKey: string, window?: { from: string; to: string },
): Promise<KpiEnvelope> {
  const qs = window ? `?from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}` : "";
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/kpis/${encodeURIComponent(formulaKey)}${qs}`,
  );
}

// ------------------------------------------------------------------------------ composed page

/**
 * The composed machine page (`/equipment/:sourceSystem/:externalId/page`,
 * `catalog.read`): every widget the equipment's class layout declares, each
 * filled or carrying why not. The page composes; it does not compute — a
 * widget's `data` is only ever what its own producer already returns
 * elsewhere (KPIs, coverage, alerts, work orders).
 */
export type PageWidgetType =
  | "kpi_number" | "kpi_gauge" | "kpi_chart" | "signal_chart" | "readiness_list"
  | "alert_list" | "work_order_list" | "service_due" | "failure_modes"
  | "recommendations" | "machine_list" | "schematic" | "parameter_list" | "forecast_chart";

export type PageReadiness = KpiReadiness;

export interface PageKpiWidgetData extends KpiEnvelope {
  target: number | null;
  targetMin: number | null;
  targetMax: number | null;
  targetDirection: string;
}

export interface PageSignalChartData {
  signal: string;
  unit: string | null;
  points: { t: string; v: number | null }[];
}

export interface PageReadinessRow {
  signal: string;
  componentScope: string;
  readiness: PageReadiness;
  reason: string | null;
  lastReadingAt: string | null;
  secondsSinceLastReading: number | null;
}

export interface PageAlertRow {
  id: string;
  severity: string;
  raisedAt: string;
  signal: string | null;
  message: string;
  acknowledged: boolean;
}

export interface PageWorkOrderRow { id: string; status: string; title: string; assignedTo: string | null; dueAt: string | null }

export interface PageServiceDueData { nextDueAt: string | null; hoursRemaining: number | null; basis: string | null }

export type PageFailureModeStatus = "active" | "clear" | "unknown";

export interface PageFailureModeRow {
  code: string; name: string; symptom: string; severity: string | null; signals: string[]; status: PageFailureModeStatus;
}

export interface PageRecommendationRow { failureModeCode: string; action: string; urgency: string; estimatedHours: number | null }

export interface PageMachineRow { sourceSystem: string; externalId: string; name: string | null; readiness: PageReadiness; openAlerts: number }

export interface PageSchematicAnchor {
  signal: string; hotspotX: number; hotspotY: number; label: string | null;
  readiness: PageReadiness; reason: string | null; value: number | null; unit: string | null;
}

export interface PageSchematicData {
  imageUrl: string;
  width: number | null;
  height: number | null;
  anchors: PageSchematicAnchor[];
  unplacedSignals: { signal: string; readiness: PageReadiness; reason: string | null }[];
}

/**
 * One operational parameter as it applies to this machine or site (`parameter_list`):
 * every parameter in the account's catalog, set or not. `source` names the scope whose
 * row supplied the value; null means nothing sets it at any scope.
 */
export interface PageParameterRow {
  name: string;
  value: unknown;
  unit: string | null;
  source: { scope: ParameterScope; scopeRef: string | null; effectiveFrom: string } | null;
}

export type PageWidgetData =
  | PageKpiWidgetData | PageSignalChartData | PageReadinessRow[] | PageAlertRow[] | PageWorkOrderRow[]
  | PageServiceDueData | PageFailureModeRow[] | PageRecommendationRow[] | PageMachineRow[] | PageSchematicData
  | PageParameterRow[] | PageForecastChartData;

/**
 * A `forecast_chart` widget (QML1): the latest forecast pass for one signal, and how the
 * latest reading sits against what was predicted for it. No band until enough residuals
 * have been learned (`baseline_not_established`) or the class has no shift schedule.
 */
export interface PageForecastChartData {
  signal: string;
  unit: string | null;
  stepSeconds: number;
  generatedAt: string;
  model: { key: string; revision: string };
  runId: string;
  horizon: { t: string; v: number; lo: number | null; hi: number | null }[];
  anomaly: {
    state: "normal" | "anomalous" | "baseline_not_established";
    baselineReason: "baseline_not_established" | "no_shift_schedule" | null;
    at: string | null;
    actual: number | null;
    predicted: number | null;
    residual: number | null;
    band: { lo: number; hi: number; n: number; learnedFrom: string; learnedTo: string } | null;
  };
}

export interface PageWidget {
  widgetKey: string;
  widgetType: PageWidgetType;
  title: string | null;
  position: number;
  size: string;
  /** Always null unless readiness is 'ready' — never 0, never [] standing in for nothing. */
  data: PageWidgetData | null;
  readiness: PageReadiness;
  reason?: string;
}

export interface MachinePage {
  equipment: {
    sourceSystem: string; externalId: string; name: string | null;
    classSlug: string | null; classVersion: number | null; plantId: string | null;
  };
  layout: { fallback: boolean };
  widgets: PageWidget[];
}

export function apiGetMachinePage(sourceSystem: string, externalId: string): Promise<MachinePage> {
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/page`,
  );
}

/** The composed dashboard for one site (`GET /sites/:plantId/page`) — every machine
 *  on it in one read, aggregated the same way a machine page is, just one level up. */
export interface SitePage {
  site: { plantId: string; code: string; name: string; siteClass: { slug: string; version: number } };
  layout: { fallback: boolean };
  widgets: PageWidget[];
}

export function apiGetSitePage(plantId: string): Promise<SitePage> {
  return authFetch(`/sites/${encodeURIComponent(plantId)}/page`);
}

// --------------------------------------------------------------------- utilization

/**
 * How the fleet spent its time (`/utilization`, `utilization.read` — every role
 * holds it; an operator's view is narrowed by which machines they can see, not by
 * the capability). Availability is uptime against *scheduled shift hours* — not
 * OEE, which would also need a performance and a quality figure this platform does
 * not compute. Depends on `equipment_shift` rows existing; without one, readiness
 * says so rather than inventing a number.
 */
export type UtilizationGroupBy = "equipment" | "plant" | "date" | "shift";

export interface UtilizationSummaryRow {
  key: string | null;
  shifts: number;
  totalSeconds: number;
  productiveSeconds: number;
  idleSeconds: number;
  runningUnclassifiedSeconds: number;
  offSeconds: number;
  unknownSeconds: number;
  engineOnSeconds: number;
  coverage: number;
  utilizationRate: number | null;
  productiveRate: number | null;
  unobservedShifts: number;
}

export interface UtilizationShiftRow {
  shiftId: string;
  shiftName: string;
  sourceSystem: string;
  externalId: string;
  plantId: string | null;
  equipmentClassSlug: string | null;
  localDate: string;
  windowStart: string;
  windowEnd: string;
  totalSeconds: number;
  productiveSeconds: number;
  idleSeconds: number;
  offSeconds: number;
  utilizationRate: number | null;
  productiveRate: number | null;
}

export type AvailabilityReadiness = "ready" | "not_configured" | "not_available";
export type AvailabilityReason = "no_shift_schedule" | "no_readings";

export interface Availability {
  scheduledHours: number;
  uptimeHours: number | null;
  downtimeHours: number | null;
  unscheduledRunningHours: number | null;
  availability: number | null;
  readiness: AvailabilityReadiness;
  reason?: AvailabilityReason;
}

export interface EquipmentAvailability extends Availability {
  sourceSystem: string;
  externalId: string;
}

export interface FleetAvailability extends Availability {
  machinesMeasured: number;
  excluded: { noShiftSchedule: number; noReadings: number };
  machines: EquipmentAvailability[];
}

export function apiGetUtilizationSummary(
  filters: { groupBy?: UtilizationGroupBy; from?: string; to?: string; plantId?: string } = {},
): Promise<UtilizationSummaryRow[]> {
  const params = new URLSearchParams();
  if (filters.groupBy) params.set("groupBy", filters.groupBy);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.plantId) params.set("plantId", filters.plantId);
  const qs = params.toString();
  return authFetch(`/utilization/summary${qs ? `?${qs}` : ""}`);
}

export function apiGetEquipmentUtilization(
  sourceSystem: string, externalId: string, range: { from?: string; to?: string } = {},
): Promise<UtilizationShiftRow[]> {
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  const qs = params.toString();
  return authFetch(
    `/utilization/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}${qs ? `?${qs}` : ""}`,
  );
}

/** `from`/`to` are both required — availability is a ratio over a stated period. */
export function apiGetFleetAvailability(from: string, to: string): Promise<FleetAvailability> {
  return authFetch(`/utilization/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
}

export function apiGetEquipmentAvailability(
  sourceSystem: string, externalId: string, from: string, to: string,
): Promise<EquipmentAvailability> {
  return authFetch(
    `/utilization/availability/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}`
      + `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
}

// ---------------------------------------------------------------------------- oee

/**
 * OEE = Availability × Performance × Quality over a UTC day, ISO week or month
 * (`utilization.read`). Each factor carries its own readiness: a factor that can't be
 * computed says why rather than reading as zero.
 */
export type OeeWindow = "day" | "week" | "month";

/** Which level supplied a parameter OEE used; `oem` is the class library's figure. */
export type OeeParameterSource = "equipment" | "class" | "site" | "client" | "oem";

export interface OeeFactor {
  /** 0..1, null unless readiness is 'ready'. */
  value: number | null;
  readiness: KpiReadiness;
  reason?: string;
}

export interface EquipmentOee {
  window: OeeWindow;
  from: string;
  to: string;
  daysCovered: number;
  availability: OeeFactor & { scheduledMinutes: number; availableMinutes: number | null };
  performance: OeeFactor & {
    breakdownMinutes: number; breakdownCount: number; openBreakdown: boolean;
    thresholdMinutes: number | null; parameterSource: OeeParameterSource | null; warning?: string;
  };
  quality: OeeFactor & {
    nominalFuel: number | null; actualFuel: number | null; unit: string | null;
    wasteFraction: number | null; wasteLitres: number | null; parameterSource: OeeParameterSource | null;
  };
  oee: OeeFactor;
}

export interface SiteOee {
  window: OeeWindow;
  from: string;
  to: string;
  daysCovered: number;
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
  machinesIncluded: number;
  /** Machines left out because their own OEE isn't ready, counted by reason. */
  machinesExcluded: Record<string, number>;
  machines: (EquipmentOee & { sourceSystem: string; externalId: string })[];
}

/** Idle with fuel inside a shift, past the threshold. `endedAt` null = still going. */
export interface BreakdownEvent {
  id: string;
  sourceSystem: string;
  externalId: string;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
  shiftId: string | null;
  thresholdMinutes: number;
}

export function apiGetEquipmentOee(
  sourceSystem: string, externalId: string, window: OeeWindow = "day",
): Promise<EquipmentOee> {
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/oee?window=${window}`,
  );
}

export function apiGetSiteOee(plantId: string, window: OeeWindow = "day"): Promise<SiteOee> {
  return authFetch(`/plants/${encodeURIComponent(plantId)}/oee?window=${window}`);
}

export function apiGetBreakdowns(
  sourceSystem: string, externalId: string, from: string, to: string,
): Promise<BreakdownEvent[]> {
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/breakdowns`
      + `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
}

// -------------------------------------------------------------------- device health

/**
 * Which loggers are in trouble, and what kind (`/device-health`, `device.read` —
 * every role holds it). The closest real equivalent to an "online/offline" filter:
 * `dark` is offline, `healthy` is online, everything between is a logger that's
 * reporting but degraded — collapsed to online/offline at the UI boundary rather
 * than losing the distinction here.
 */
export type DeviceLinkState = 'dark' | 'partial' | 'intermittent' | 'buffering' | 'weak-signal' | 'healthy' | 'unknown';

export interface FleetLinkRow {
  imei: string;
  externalId: string;
  state: DeviceLinkState;
  detail: string;
  windowStart: string;
  windowEnd: string;
  windowsInState: number;
  signalBand: string | null;
  signalWorstBand: string | null;
  longestGapSeconds: number | null;
  medianLagSeconds: number | null;
  missingSignals: string[];
}

/** One assessment window for one logger (`/device-health/:imei`), newest first, up to 50. */
export interface DeviceHealthWindow {
  id: string;
  imei: string;
  sourceSystem: string;
  externalId: string;
  localDate: string;
  windowStart: string;
  windowEnd: string;
  state: DeviceLinkState;
  detail: string;
  signalScale: string | null;
  signalMedian: number | null;
  signalWorst: number | null;
  signalBand: string | null;
  signalWorstBand: string | null;
  longestGapSeconds: number | null;
  medianLagSeconds: number | null;
  maxLagSeconds: number | null;
  reportedSignals: string[];
  missingSignals: string[];
  samples: number;
}

/** Narrowed server-side to machines the caller may see. */
export function apiGetDeviceHealth(imei: string): Promise<DeviceHealthWindow[]> {
  return authFetch(`/device-health/${encodeURIComponent(imei)}`);
}

export function apiGetDeviceHealthFleet(
  filters: { states?: DeviceLinkState[]; days?: number } = {},
): Promise<FleetLinkRow[]> {
  const params = new URLSearchParams();
  if (filters.states?.length) params.set("state", filters.states.join(","));
  if (filters.days) params.set("days", String(filters.days));
  const qs = params.toString();
  return authFetch(`/device-health${qs ? `?${qs}` : ""}`);
}

// ------------------------------------------------------------------------------ shifts

/**
 * When a machine is worked (`/equipment/:sourceSystem/:externalId/shifts`,
 * `equipment.write` to change, `catalog.read` to list). Hours are wall-clock in the
 * shift's own `timeZone`, never a UTC offset. `days`: 0 = Sunday … 6 = Saturday.
 * Everything utilization/availability reports depends on at least one of these
 * existing — a machine with none is "not_configured", not a zero.
 */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type ShiftStatus = "active" | "retired";

export interface EquipmentShift {
  id: string;
  sourceSystem: string;
  externalId: string;
  name: string;
  startMinute: number;
  endMinute: number;
  days: Weekday[];
  timeZone: string;
  status: ShiftStatus;
  scoredThrough: string | null;
  arrivalsThrough: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShiftInput {
  name: string;
  startMinute: number;
  endMinute: number;
  days: Weekday[];
  timeZone: string;
}

export type ShiftPatchInput = Partial<ShiftInput>;

export type ShiftRunStatus = "scored" | "nothing-to-score" | "not-running" | "failed";

export interface ShiftRun {
  id: string;
  shiftId: string;
  shiftName: string;
  sourceSystem: string;
  externalId: string;
  localDate: string;
  windowStart: string;
  windowEnd: string;
  status: ShiftRunStatus;
  detail: string | null;
  readings: number;
  predictions: number;
  jobsRaised: number;
  alertsFired: number;
  durationMs: number | null;
  ranAt: string;
}

export function apiListShifts(sourceSystem: string, externalId: string): Promise<EquipmentShift[]> {
  return authFetch(`/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/shifts`);
}

export function apiGetShiftRuns(sourceSystem: string, externalId: string): Promise<ShiftRun[]> {
  return authFetch(`/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/shifts/runs`);
}

export function apiCreateShift(sourceSystem: string, externalId: string, input: ShiftInput): Promise<EquipmentShift> {
  return authFetch(`/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/shifts`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function apiUpdateShift(
  sourceSystem: string, externalId: string, id: string, input: ShiftPatchInput,
): Promise<EquipmentShift> {
  return authFetch(`/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/shifts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function apiRetireShift(sourceSystem: string, externalId: string, id: string): Promise<EquipmentShift> {
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/shifts/${encodeURIComponent(id)}/retire`,
    { method: "POST" },
  );
}

export function apiReinstateShift(sourceSystem: string, externalId: string, id: string): Promise<EquipmentShift> {
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/shifts/${encodeURIComponent(id)}/reinstate`,
    { method: "POST" },
  );
}

export type ServiceKind = "scheduled" | "unscheduled" | "overhaul" | "meter-replaced";
export type RuntimeUnit = "hours" | "minutes" | "seconds";

export interface EquipmentServiceRecord {
  id: string;
  sourceSystem: string;
  externalId: string;
  performedAt: string;
  kind: ServiceKind;
  meterReading: number | null;
  meterUnit: RuntimeUnit | null;
  workOrderId: string | null;
  notes: string | null;
  recordedBy: string | null;
  recordedAt: string;
}

export interface RecordServiceInput {
  performedAt?: string;
  kind?: ServiceKind;
  meterReading?: number;
  meterUnit?: RuntimeUnit;
  workOrderId?: string;
  notes?: string;
}

export function apiGetServiceHistory(sourceSystem: string, externalId: string): Promise<EquipmentServiceRecord[]> {
  return authFetch(`/service/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}`);
}

export function apiRecordService(
  sourceSystem: string, externalId: string, input: RecordServiceInput,
): Promise<EquipmentServiceRecord> {
  return authFetch(`/service/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type ServiceStatus = "overdue" | "due" | "approaching" | "ok";

export interface Calibration {
  unit: RuntimeUnit | null;
  confidence: "high" | "low" | "none";
  reason?: "no-usable-windows" | "too-few-windows" | "no-unit-matches" | "disagreement";
  usable: number;
  considered: number;
  medianRatio: number | null;
  agreement: number | null;
}

export interface FleetComparison {
  hoursPerDay: number | null;
  fleetHoursPerDay: number | null;
  ratio: number | null;
  outrunning: boolean;
  peers: number;
  reason?: "too-few-peers" | "no-rate";
}

/** Next service per machine — the same computation that backs the Equipment
 *  Page's "service_due" widget, here returned for the whole fleet at once. */
export interface AssetForecast {
  status: ServiceStatus | null;
  intervalHours: number | null;
  intervalSource: "equipment" | "class" | null;
  hoursSinceDatum: number | null;
  hoursRemaining: number | null;
  hoursPerDay: number | null;
  dueAt: string | null;
  daysRemaining: number | null;
  datum: "service-record" | "commissioning" | null;
  missing: ("interval" | "meter-unit" | "meter-reading" | "datum" | "rate")[];
  sourceSystem: string;
  externalId: string;
  name: string | null;
  equipmentClassSlug: string | null;
  plantId: string | null;
  fleet: FleetComparison;
  lastServiceAt: string | null;
  meterReadingAt: string | null;
}

export interface ServiceForecastResponse {
  calibration: Calibration;
  assets: AssetForecast[];
}

export function apiGetServiceForecast(): Promise<ServiceForecastResponse> {
  return authFetch(`/service/forecast`);
}

// -------------------------------------------------------------------------- predictions

/**
 * Deterministic Tier-1 scoring (`/predictions`, `prediction.read` / `prediction.run`).
 * `riskScore` is a composite 0–100 (70% worst signal + 30% mean, rule-based — never a
 * fabricated probability). There is deliberately no remaining-useful-life field
 * anywhere in this module or its entity (`docs/ai/START-HERE.md` G07: "No fabricated
 * probabilities, RUL, OEM limits or labels") — a RUL-shaped UI has nothing real to
 * read here.
 */
export type PredictionSeverity = "none" | "low" | "medium" | "high" | "critical";
export type PredictionConfidence = "full" | "partial" | "none";
export type SignalState = "normal" | "warning" | "critical" | "unscored";

export interface SignalVerdict {
  signal: string;
  state: SignalState;
  z: number | null;
  value: number | null;
  mean: number | null;
  stddev: number | null;
  reason?: string;
}

export interface Prediction {
  id: string;
  sourceSystem: string;
  externalId: string;
  clientScenarioSlug: string;
  severity: PredictionSeverity;
  riskScore: number;
  abnormalCount: number;
  highPriority: boolean;
  confidence: PredictionConfidence;
  signals: SignalVerdict[];
  windowDays: number;
  modelRef: string;
  modelTier: number;
  source: "live" | "replayed";
  occurredAt: string;
  computedAt: string;
}

export type PredictionSkipReason = "no-device" | "no-readings" | "scenario-missing" | "scenario-disabled";

export interface ScoreResult {
  written: Prediction[];
  skipped: { clientScenarioSlug: string; reason: PredictionSkipReason }[];
  raised: { clientScenarioSlug: string; workOrderId: string }[];
}

/** The latest row per active scenario — a machine with several active scenarios gets
 *  several rows, each explained on its own. */
export function apiGetLatestPredictions(sourceSystem: string, externalId: string): Promise<Prediction[]> {
  return authFetch(`/predictions/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}`);
}

export function apiGetPredictionHistory(
  sourceSystem: string, externalId: string, clientScenarioSlug: string, take?: number,
): Promise<Prediction[]> {
  const qs = take ? `?take=${take}` : "";
  return authFetch(
    `/predictions/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/${encodeURIComponent(clientScenarioSlug)}/history${qs}`,
  );
}

/** One watched signal of a scenario, opened up: its readings over a window ending at
 *  the latest verdict, and the lines that verdict was judged against. The bands come
 *  back computed (overrides applied) so the chart never draws a threshold the scorer
 *  did not use. `baseline` is null for an influence-model score or before a baseline
 *  exists; `verdict` is null before the first score. */
export interface PredictionSignalDetail {
  clientScenarioSlug: string;
  signal: string;
  predictionId: string | null;
  occurredAt: string | null;
  modelRef: string | null;
  verdict: (SignalVerdict & { expected?: number; residual?: number }) | null;
  baseline: {
    windowDays: number; mean: number; stddev: number; sampleCount: number; coverageRatio: number;
    warningSigma: number; criticalSigma: number;
    warning: { lo: number; hi: number };
    critical: { lo: number; hi: number };
  } | null;
  window: { from: string; to: string; bucketSeconds: number };
  readings: { at: string; avg: number; min: number; max: number; count: number }[];
}

export function apiGetPredictionSignalDetail(
  sourceSystem: string, externalId: string, clientScenarioSlug: string, signal: string, hours?: number,
): Promise<PredictionSignalDetail> {
  const qs = hours ? `?hours=${hours}` : "";
  return authFetch(
    `/predictions/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/${encodeURIComponent(clientScenarioSlug)}/signals/${encodeURIComponent(signal)}${qs}`,
  );
}

/** Scores every active scenario on this asset right now, rather than waiting for the
 *  next arrival to trigger it — the one case the route exists for. */
export function apiScorePredictionsNow(sourceSystem: string, externalId: string): Promise<ScoreResult> {
  return authFetch(`/predictions/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/score`, {
    method: "POST",
  });
}

/** The per-signal mean/stddev Tier-1 scoring measures every value against — a derived
 *  cache, not a system of record. `mean`/`stddev`/`z` already surface per-signal on
 *  each Prediction; this is the provenance behind those numbers (sample count,
 *  coverage, when it was last computed) plus the manual recompute action for "just
 *  fitted a sensor, want fresh numbers now". */
export interface PredictionBaseline {
  id: string;
  sourceSystem: string;
  externalId: string;
  signal: string;
  windowDays: number;
  mean: number;
  stddev: number;
  sampleCount: number;
  coverageRatio: number;
  firstSampleAt: string;
  lastSampleAt: string;
  source: "live" | "replayed" | "mixed";
  computedAt: string;
}

export function apiGetPredictionBaselines(
  sourceSystem: string, externalId: string, windowDays?: number,
): Promise<PredictionBaseline[]> {
  const qs = windowDays ? `?windowDays=${windowDays}` : "";
  return authFetch(`/predictions/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/baselines${qs}`);
}

export function apiRefreshPredictionBaselines(
  sourceSystem: string, externalId: string, windowDays?: number,
): Promise<PredictionBaseline[]> {
  const qs = windowDays ? `?windowDays=${windowDays}` : "";
  return authFetch(
    `/predictions/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/baselines/refresh${qs}`,
    { method: "POST" },
  );
}

// -------------------------------------------------------------- client equipment classes

/**
 * The tenant's own copy of an equipment class (`/my-catalog/equipment-classes`,
 * `client-catalog.read` / `client-catalog.write`) — separate from `/catalog`, which
 * serves Things Alive's templates. Reads are open to every role in the account;
 * writes are super admin alone.
 */
export interface MyEquipmentClass {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  expectedSignals: ExpectedSignal[];
  failureModes: FailureMode[];
  defaultThresholds: Record<string, unknown>;
  templateSlug: string | null;
  templateVersion: number | null;
  status: "active" | "retired";
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EditMyEquipmentClassInput {
  name?: string;
  description?: string;
  category?: string;
  expectedSignals?: ExpectedSignal[];
  failureModes?: FailureMode[];
  defaultThresholds?: Record<string, unknown>;
}

export function apiListMyCatalogEquipmentClasses(): Promise<(MyEquipmentClass & { provenance: ScenarioProvenance })[]> {
  return authFetch("/my-catalog/equipment-classes");
}

export function apiGetMyCatalogEquipmentClass(slug: string): Promise<MyEquipmentClass> {
  return authFetch(`/my-catalog/equipment-classes/${encodeURIComponent(slug)}`);
}

export function apiEditMyCatalogEquipmentClass(slug: string, input: EditMyEquipmentClassInput): Promise<MyEquipmentClass> {
  return authFetch(`/my-catalog/equipment-classes/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export interface MyClassLayoutWidget {
  widgetType: string;
  widgetKey: string;
  boundTo: string | null;
  title: string | null;
  position: number;
  size: string;
  hidden: boolean;
  /** True once the tenant has moved it — a deliberate change, never silently reverted
   *  when the class is next upgraded. */
  positionCustom: boolean;
}

export function apiGetMyCatalogClassLayout(
  slug: string,
): Promise<{ fallback: boolean; widgets: MyClassLayoutWidget[] }> {
  return authFetch(`/my-catalog/equipment-classes/${encodeURIComponent(slug)}/layout`);
}

export function apiSetMyCatalogWidgetHidden(slug: string, widgetKey: string, hidden: boolean) {
  return authFetch(
    `/my-catalog/equipment-classes/${encodeURIComponent(slug)}/layout/${encodeURIComponent(widgetKey)}`,
    { method: "PATCH", body: JSON.stringify({ hidden }) },
  );
}

/** Every widget key, in the order wanted — not a partial move. */
export function apiReorderMyCatalogLayout(slug: string, widgetKeys: string[]) {
  return authFetch(`/my-catalog/equipment-classes/${encodeURIComponent(slug)}/layout/order`, {
    method: "PUT",
    body: JSON.stringify({ widgetKeys }),
  });
}

// ------------------------------------------------------------------- class upgrade

/**
 * Moving the account's copy of a class to the library's latest published version
 * (`/my-catalog/equipment-classes/:slug/upgrade`). Read the preview, then apply exactly
 * the version it showed. Inherited content follows the library; anything the account
 * changed or added is kept.
 */
export type UpgradeOrigin = "inherited" | "customised" | "tenant_added";
export type UpgradeUpstream = "unchanged" | "changed" | "removed" | "added";
/** replace = follows the library · keep = the account's own version stays ·
 *  orphan = the library dropped it, the account's row stays · add = new from the library. */
export type UpgradeAction = "replace" | "keep" | "orphan" | "add";

export interface UpgradeChange {
  key: string;
  /** null for a row the new version adds and the account never had. */
  origin: UpgradeOrigin | null;
  upstream: UpgradeUpstream;
  action: UpgradeAction;
}

export interface ClassUpgradePreview {
  slug: string;
  fromVersion: number;
  toVersion: number;
  upToDate: boolean;
  classFields: { origin: "inherited" | "customised"; action: "replace" | "keep" };
  formulas: UpgradeChange[];
  failureModes: UpgradeChange[];
  recommendations: UpgradeChange[];
  layout: { added: string[]; removed: string[]; keptCustom: string[] };
  anchors: { added: string[]; removed: string[]; keptCustom: string[]; needsRecheck: string[] };
}

export interface ClassUpgradeResult extends ClassUpgradePreview {
  /** false when it was already at that version — a repeat is a no-op that says so. */
  upgraded: boolean;
}

export function apiPreviewClassUpgrade(slug: string): Promise<ClassUpgradePreview> {
  return authFetch(`/my-catalog/equipment-classes/${encodeURIComponent(slug)}/upgrade`);
}

/** Refused if a newer version has published since the preview: re-read and confirm again. */
export function apiApplyClassUpgrade(slug: string, toVersion: number): Promise<ClassUpgradeResult> {
  return authFetch(`/my-catalog/equipment-classes/${encodeURIComponent(slug)}/upgrade`, {
    method: "POST",
    body: JSON.stringify({ toVersion }),
  });
}

// ------------------------------------------------------------------- client scenarios

/**
 * A client's own copy of a prediction scenario (`/my-catalog/scenarios`,
 * `client-catalog.read`) — what `apiActivationTransition` turns on and off per machine.
 * Edited and owned by the client once copied; nothing here is bounds-checked
 * against the template it came from.
 */
export interface ClientScenario {
  id: string;
  slug: string;
  clientEquipmentClassSlug: string;
  name: string;
  description: string | null;
  severity: "none" | "low" | "medium" | "high" | "critical";
  tier: 1 | 2 | 3;
  requiredSignals: string[];
  minimumHistoryDays: number;
  parameters: ScenarioParameter[];
  enabled: boolean;
  templateSlug: string | null;
  templateVersion: number | null;
  status: "active" | "retired";
  updatedAt: string;
}

export function apiListMyCatalogScenarios(equipmentClassSlug?: string): Promise<ClientScenario[]> {
  const qs = equipmentClassSlug ? `?class=${encodeURIComponent(equipmentClassSlug)}` : "";
  return authFetch(`/my-catalog/scenarios${qs}`);
}

/** Answers the two questions that matter about a copy: is it still what was shipped,
 *  and is a newer template available. */
export interface ScenarioProvenance {
  templateSlug: string | null;
  templateVersion: number | null;
  unchangedSinceCopy: boolean;
  newerTemplateAvailable: boolean;
  newerTemplateVersion: number | null;
  copiedAt: string | null;
}

export function apiGetMyCatalogScenario(slug: string): Promise<ClientScenario & { provenance: ScenarioProvenance }> {
  return authFetch(`/my-catalog/scenarios/${encodeURIComponent(slug)}`);
}

export interface EditClientScenarioInput {
  name?: string;
  description?: string;
  severity?: "none" | "low" | "medium" | "high" | "critical";
  tier?: 1 | 2 | 3;
  requiredSignals?: string[];
  minimumHistoryDays?: number;
  parameters?: ScenarioParameter[];
  enabled?: boolean;
}

export function apiEditMyCatalogScenario(slug: string, input: EditClientScenarioInput): Promise<ClientScenario> {
  return authFetch(`/my-catalog/scenarios/${encodeURIComponent(slug)}`, { method: "PATCH", body: JSON.stringify(input) });
}

/** Discards every local edit and replaces this copy with the latest published
 *  template version. */
export function apiAdoptLatestScenarioTemplate(slug: string): Promise<ClientScenario> {
  return authFetch(`/my-catalog/scenarios/${encodeURIComponent(slug)}/adopt-latest-template`, { method: "POST" });
}

// ----------------------------------------------------------------------- activation

/**
 * Turning a client scenario on and off for one machine (`/activations`,
 * `scenario.activate` to write; `client-catalog.read` to list). One shared `action`
 * call rather than five exports, mirroring the backend's own single
 * `apply(scope, action, dto)` shape — propose/pause/deactivate take a reason,
 * activate/resume don't need one.
 */
export type ActivationState = "proposed" | "active" | "paused" | "deactivated";
export type ActivationAction = "propose" | "activate" | "pause" | "resume" | "deactivate";

export type ActivationBlocker =
  | { code: "unclassified" }
  | { code: "class-not-in-account" }
  | { code: "scenario-disabled" }
  | { code: "no-device" }
  | { code: "missing-signals"; signals: string[] }
  | { code: "insufficient-history"; haveDays: number; needDays: number }
  | { code: "tier-too-low"; have: string; needs: 1 | 2 | 3 };

export interface ResolvedActivationParameter {
  key: string;
  value: unknown;
  source: "scenario-default" | "asset-override";
}

export interface ActivationView {
  id: string;
  sourceSystem: string;
  externalId: string;
  clientScenarioSlug: string;
  state: ActivationState;
  parameterOverrides: Record<string, unknown>;
  blockersAtActivation: ActivationBlocker[];
  activatedBy: string | null;
  activatedAt: string | null;
  stateChangedBy: string | null;
  stateChangedAt: string | null;
  stateReason: string | null;
  lastEvaluatedAt: string | null;
  resolvedParameters: ResolvedActivationParameter[];
}

export function apiListActivations(
  filters: { sourceSystem?: string; externalId?: string; state?: ActivationState } = {},
): Promise<ActivationView[]> {
  const params = new URLSearchParams();
  if (filters.sourceSystem) params.set("sourceSystem", filters.sourceSystem);
  if (filters.externalId) params.set("externalId", filters.externalId);
  if (filters.state) params.set("state", filters.state);
  const qs = params.toString();
  return authFetch(`/activations${qs ? `?${qs}` : ""}`);
}

export function apiActivationTransition(
  action: ActivationAction,
  input: {
    sourceSystem: string;
    externalId: string;
    clientScenarioSlug: string;
    reason?: string;
    parameterOverrides?: Record<string, unknown>;
  },
): Promise<ActivationView> {
  return authFetch(`/activations/${action}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Who turned what on and off for this asset, and why — across every scenario,
 *  newest first (`/activations/history/:sourceSystem/:externalId`). */
export interface ActivationHistoryEvent {
  id: string;
  sourceSystem: string;
  externalId: string;
  clientScenarioSlug: string;
  action: ActivationAction;
  fromState: ActivationState | null;
  toState: ActivationState;
  reason: string | null;
  blockers: ActivationBlocker[];
  actorUserId: string;
  actorRoles: string[];
  at: string;
}

export function apiGetActivationHistory(
  sourceSystem: string,
  externalId: string,
): Promise<ActivationHistoryEvent[]> {
  return authFetch(
    `/activations/history/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}`,
  );
}

/** Which scenarios this asset can run right now, and what's stopping the rest
 *  (`/catalog/equipment/:sourceSystem/:externalId/recommendations`, `catalog.read`) —
 *  computed fresh from recorded metadata every call, unlike `ActivationView.blockersAtActivation`
 *  which is a snapshot from whenever activation was last attempted. */
export type RecommendationBucket = "availableNow" | "availableLater" | "notApplicable";

export interface EquipmentRecommendation {
  scenarioSlug: string;
  scenarioVersion: number;
  name: string;
  severity: string;
  tier: 1 | 2 | 3;
  bucket: RecommendationBucket;
  blockedBy: ActivationBlocker[];
  estimatedReadyDate: string | null;
}

export function apiGetEquipmentRecommendations(
  sourceSystem: string,
  externalId: string,
): Promise<{ equipmentClassSlug: string | null; recommendations: EquipmentRecommendation[] }> {
  return authFetch(
    `/catalog/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/recommendations`,
  );
}

// --------------------------------------------------------------------- work orders

/**
 * Jobs on machines (`/work-orders`, `action.work`/`action.assign`). Status and
 * assignment move through their own routes, never a bare PATCH — `complete`,
 * `cancel` and `reopen` all require a note; see `apiActOnWorkOrder`.
 */
export type WorkOrderStatus = "created" | "in-progress" | "completed" | "cancelled";
export type WorkOrderPriority = "low" | "normal" | "high" | "urgent";
export type WorkOrderOrigin = "manual" | "prediction";
export type WorkOrderAction = "start" | "complete" | "cancel" | "reopen";

export interface WorkOrder {
  id: string;
  reference: string;
  sourceSystem: string;
  externalId: string;
  title: string;
  description: string | null;
  status: WorkOrderStatus;
  priority: WorkOrderPriority;
  assignedToUserId: string | null;
  predictionId: string | null;
  origin: WorkOrderOrigin;
  raisedForScenario: string | null;
  dueAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  resolution: string | null;
  raisedBy: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkOrderEventKind =
  | "raised" | "assigned" | "unassigned" | "started" | "completed" | "cancelled" | "reopened" | "edited";

export interface WorkOrderEvent {
  id: string;
  workOrderId: string;
  kind: WorkOrderEventKind;
  fromStatus: WorkOrderStatus | null;
  toStatus: WorkOrderStatus | null;
  fromAssignee: string | null;
  toAssignee: string | null;
  note: string | null;
  actorUserId: string;
  at: string;
}

export interface RaiseWorkOrderInput {
  sourceSystem: string;
  externalId: string;
  title: string;
  description?: string;
  priority?: WorkOrderPriority;
  assignedToUserId?: string;
  predictionId?: string;
  dueAt?: string;
}

export interface EditWorkOrderInput {
  title?: string;
  description?: string;
  priority?: WorkOrderPriority;
  dueAt?: string;
}

export function apiListWorkOrders(
  filters: { status?: WorkOrderStatus[]; equipment?: string; mine?: boolean; overdue?: boolean } = {},
): Promise<WorkOrder[]> {
  const params = new URLSearchParams();
  if (filters.status?.length) params.set("status", filters.status.join(","));
  if (filters.equipment) params.set("equipment", filters.equipment);
  if (filters.mine) params.set("mine", "true");
  if (filters.overdue) params.set("overdue", "true");
  const qs = params.toString();
  return authFetch(`/work-orders${qs ? `?${qs}` : ""}`);
}

export function apiRaiseWorkOrder(input: RaiseWorkOrderInput): Promise<WorkOrder> {
  return authFetch("/work-orders", { method: "POST", body: JSON.stringify(input) });
}

export function apiGetWorkOrderHistory(id: string): Promise<WorkOrderEvent[]> {
  return authFetch(`/work-orders/${encodeURIComponent(id)}/history`);
}

export function apiEditWorkOrder(id: string, input: EditWorkOrderInput): Promise<WorkOrder> {
  return authFetch(`/work-orders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
}

/** Active people in this account, by name — the assignee picker and the history read
 *  names from here (`action.work`; works for a site manager, unlike /identity/users). */
export function apiListWorkOrderPeople(): Promise<{ id: string; fullName: string }[]> {
  return authFetch("/work-orders/people");
}

export function apiAssignWorkOrder(id: string, userId: string | null, note?: string): Promise<WorkOrder> {
  return authFetch(`/work-orders/${encodeURIComponent(id)}/assign`, {
    method: "POST",
    body: JSON.stringify({ userId, note }),
  });
}

/** `complete`, `cancel` and `reopen` throw if `note` is blank — the state machine
 *  requires a reason for each (a completed job with no note is, a month later,
 *  indistinguishable from an abandoned one). `start` takes an optional one. */
export function apiActOnWorkOrder(id: string, action: WorkOrderAction, note?: string): Promise<WorkOrder> {
  return authFetch(`/work-orders/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

// --------------------------------------------------------------------------- alerts

/**
 * A client's own standing rules (`/alerts/rules`, `alert.author` to write,
 * `prediction.read` to list) and what they've fired (`/alerts`, `action.work` to
 * acknowledge/resolve). Distinct from the catalog's `AlertRuleTemplate` above —
 * this is the tenant's copy, scoped to their account/plant/equipment.
 */
export type AlertRuleSeverity = "none" | "low" | "medium" | "high" | "critical";
export type AlertAppliesTo = "account" | "plant" | "equipment" | "equipment-class";
export type AlertState = "open" | "acknowledged" | "resolved";

export interface AlertRule {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  trigger: AlertTrigger;
  params: AlertParams;
  appliesTo: AlertAppliesTo;
  plantId: string | null;
  sourceSystem: string | null;
  externalId: string | null;
  equipmentClassSlug: string | null;
  severity: AlertRuleSeverity;
  enabled: boolean;
  templateSlug: string | null;
  templateVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AlertRuleInput {
  slug: string;
  name: string;
  description?: string;
  trigger: AlertTrigger;
  params: AlertParams;
  appliesTo?: Exclude<AlertAppliesTo, "equipment-class">;
  plantId?: string;
  sourceSystem?: string;
  externalId?: string;
  severity?: AlertRuleSeverity;
}

export type AlertRulePatch = Partial<AlertRuleInput>;

export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  sourceSystem: string;
  externalId: string;
  severity: AlertRuleSeverity;
  summary: string;
  evidence: Record<string, unknown>;
  shiftLocalDate: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  predictionId: string | null;
  state: AlertState;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  firedAt: string;
}

export function apiListAlerts(filters: { state?: AlertState[]; equipment?: string } = {}): Promise<AlertEvent[]> {
  const params = new URLSearchParams();
  if (filters.state?.length) params.set("state", filters.state.join(","));
  if (filters.equipment) params.set("equipment", filters.equipment);
  const qs = params.toString();
  return authFetch(`/alerts${qs ? `?${qs}` : ""}`);
}

export function apiAcknowledgeAlert(id: string): Promise<AlertEvent> {
  return authFetch(`/alerts/${encodeURIComponent(id)}/acknowledge`, { method: "POST" });
}

export function apiResolveAlert(id: string, note: string): Promise<AlertEvent> {
  return authFetch(`/alerts/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

export function apiListAlertRules(): Promise<AlertRule[]> {
  return authFetch("/alerts/rules");
}

export function apiCreateAlertRule(input: AlertRuleInput): Promise<AlertRule> {
  return authFetch("/alerts/rules", { method: "POST", body: JSON.stringify(input) });
}

export function apiUpdateAlertRule(id: string, input: AlertRulePatch): Promise<AlertRule> {
  return authFetch(`/alerts/rules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function apiDisableAlertRule(id: string): Promise<AlertRule> {
  return authFetch(`/alerts/rules/${encodeURIComponent(id)}/disable`, { method: "POST" });
}

export function apiEnableAlertRule(id: string): Promise<AlertRule> {
  return authFetch(`/alerts/rules/${encodeURIComponent(id)}/enable`, { method: "POST" });
}

// ------------------------------------------------------------------------- parameters

/**
 * The client's own cost/operational parameters (`/parameters`, `parameters.read` /
 * `parameters.write`). Client-owned, append-only, effective-dated — there is no
 * platform scope and no platform default (D39): a value Things Alive chose would be
 * a number the customer never agreed to. `name` is a closed, platform-declared list
 * (`parameter-catalog.ts`) plus whatever this account's own formulas require.
 */
export type ParameterScope = "client" | "site" | "equipment_class" | "equipment";

export interface ParameterCatalogEntry {
  name: string;
  unit: string | null;
  kind: "number" | "currency_code";
  costTyped: boolean;
  description: string | null;
  source: "operational" | "formula";
  requiredBy: { classSlug: string; formulaKey: string }[];
}

export interface EffectiveParameter {
  name: string;
  value: number | string | null;
  unit: string | null;
  source: { scope: ParameterScope; scopeRef: string | null; effectiveFrom: string } | null;
}

export interface TenantParameterRow {
  id: string;
  scope: ParameterScope;
  /** Null for client; the plant id for site; the class slug for equipment_class;
   *  the equipment profile's own id (not sourceSystem/externalId) for equipment. */
  scopeRef: string | null;
  name: string;
  value: number | string | null;
  unit: string | null;
  effectiveFrom: string;
  createdBy: string;
  createdAt: string;
}

export interface CurrencyResult {
  currency: string | null;
  changed: boolean;
  effectiveFrom: string | null;
}

export function apiGetParameterCatalog(): Promise<ParameterCatalogEntry[]> {
  return authFetch("/parameters/catalog");
}

export function apiGetEffectiveParameters(
  target: { scope: ParameterScope; scopeRef?: string },
): Promise<EffectiveParameter[]> {
  const params = new URLSearchParams({ scope: target.scope });
  if (target.scopeRef) params.set("scopeRef", target.scopeRef);
  return authFetch(`/parameters?${params.toString()}`);
}

export function apiGetParameterHistory(
  name: string, target?: { scope: ParameterScope; scopeRef?: string },
): Promise<TenantParameterRow[]> {
  const params = new URLSearchParams({ name });
  if (target?.scope) params.set("scope", target.scope);
  if (target?.scopeRef) params.set("scopeRef", target.scopeRef);
  return authFetch(`/parameters/history?${params.toString()}`);
}

/** `value: null` clears this scope's value — the next scope up answers from then on. */
export function apiSetParameter(input: {
  scope: ParameterScope; scopeRef?: string; name: string; value: number | null; unit?: string;
}): Promise<TenantParameterRow> {
  return authFetch("/parameters", { method: "POST", body: JSON.stringify(input) });
}

/** Refused while any cost-typed value exists anywhere in the account. */
export function apiSetCurrency(currency: string | null): Promise<CurrencyResult> {
  return authFetch("/parameters/currency", { method: "POST", body: JSON.stringify({ currency }) });
}

// ------------------------------------------------------------------- my permissions

export interface MeDiagnostics {
  tenantId: string;
  userId: string;
  /** Null for a token that names no account row (one minted by the CLI). */
  email: string | null;
  fullName: string | null;
  roles: string[];
  isPlatformRole: boolean;
  scope: {
    plants: string[] | "unrestricted";
    equipment: string[] | "unrestricted";
    devices: string[] | "unrestricted";
  };
}

/** GET /me — the resolved scope for this token, raw. A support/debugging aid. */
export function apiGetMe(): Promise<MeDiagnostics> {
  return authFetch("/me");
}

/** GET /me/permissions — what the signed-in caller may do, and which pages they see. */
export function apiMyPermissions(): Promise<{
  tenantId: string;
  capabilities: Record<string, boolean>;
  allowedTabs: string[];
}> {
  return authFetch("/me/permissions");
}

/** POST /me/change-password — every session (including this one's refresh token) is revoked on success. */
export function apiChangePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ changed: boolean }> {
  return authFetch("/me/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

// ------------------------------------------------------------------------- roles

/**
 * A client's own role (/identity/roles, `role.manage` — that account's own super
 * admin only). `capabilities` gates the API; `allowedTabs` gates which pages the
 * console shows — two different questions, never merged.
 */
export interface TenantRole {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  capabilities: string[];
  scopeShape: "tenant" | "plant" | "equipment";
  allowedTabs: string[];
  isBuiltIn: boolean;
  templateSlug: string | null;
  updatedAt: string;
}

export interface RoleInput {
  slug: string;
  name: string;
  description?: string;
  capabilities: string[];
  scopeShape: TenantRole["scopeShape"];
  allowedTabs: string[];
}

export interface RolePatchInput {
  name?: string;
  description?: string;
  allowedTabs?: string[];
}

export function apiListRoles(): Promise<TenantRole[]> {
  return authFetch("/identity/roles");
}

export function apiCreateRole(input: RoleInput): Promise<TenantRole> {
  return authFetch("/identity/roles", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function apiUpdateRole(
  slug: string,
  input: RolePatchInput,
): Promise<TenantRole> {
  return authFetch(`/identity/roles/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function apiDeleteRole(slug: string): Promise<void> {
  return authFetch(`/identity/roles/${encodeURIComponent(slug)}`, {
    method: "DELETE",
  });
}

// -------------------------------------------------------------------------- users

/**
 * A person inside the signed-in client's own account (/identity/users,
 * `user.manage` — that account's own super admin only). Invite-only: there is no
 * admin-set password, and no username — a person accepts an invitation and sets
 * their own credential, the same flow already used for a new account's first
 * super admin.
 */
export interface TenantUser {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  roleSlug: string;
  status: "invited" | "active" | "suspended";
  suspendedReason: string | null;
  plants: { plantId: string }[];
  equipment: { sourceSystem: string; equipmentExternalId: string }[];
}

export interface InviteUserInput {
  email: string;
  fullName: string;
  roleSlug: string;
  phone?: string;
}

export interface InviteUserResult extends TenantUser {
  invitationToken?: string;
  invitationExpiresAt?: string;
}

export function apiListTenantUsers(): Promise<TenantUser[]> {
  return authFetch("/identity/users");
}

export function apiInviteUser(
  input: InviteUserInput,
): Promise<InviteUserResult> {
  return authFetch("/identity/users", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function apiSetUserRole(
  userId: string,
  roleSlug: string,
): Promise<TenantUser> {
  return authFetch(`/identity/users/${encodeURIComponent(userId)}/role`, {
    method: "PUT",
    body: JSON.stringify({ roleSlug }),
  });
}

/** Replaces this person's site/machine assignments wholesale (`PUT /identity/users/:id/access`).
 *  Only meaningful for a role whose `scopeShape` is "plant" or "equipment" — a
 *  "tenant"-scoped role ignores these rows entirely and always sees everything.
 *  Leaving a field empty does not mean "unrestricted": it means this person is
 *  assigned to nothing of that kind and sees nothing of that kind. */
export interface SetUserAccessInput {
  plants?: { plantId: string }[];
  equipment?: { sourceSystem: string; equipmentExternalId: string }[];
}

export function apiSetUserAccess(
  userId: string,
  input: SetUserAccessInput,
): Promise<TenantUser> {
  return authFetch(`/identity/users/${encodeURIComponent(userId)}/access`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function apiSuspendUser(
  userId: string,
  reason: string,
): Promise<TenantUser> {
  return authFetch(`/identity/users/${encodeURIComponent(userId)}/suspend`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function apiReinstateUser(userId: string): Promise<TenantUser> {
  return authFetch(`/identity/users/${encodeURIComponent(userId)}/reinstate`, {
    method: "POST",
  });
}

/** Only somebody who never signed in, and never the account's only super admin. */
export function apiDeleteUser(userId: string): Promise<void> {
  return authFetch(`/identity/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

/** A new token for an invited person who lost theirs. The old token stops working. */
export function apiResendUserInvitation(userId: string): Promise<ResendInvitationResult> {
  return authFetch(`/identity/users/${encodeURIComponent(userId)}/resend-invitation`, { method: "POST" });
}

// ----------------------------------------------------------------- onboarding status

/**
 * How far along each machine is, derived — never stored — from the tables that own each
 * fact (`/onboarding/status`, `equipment.write`). A site is the "session" the AI
 * Onboarding list shows (QONBOARD-STATUS §2).
 */
export type OnboardingStepName = "equipment" | "device" | "mapping" | "validation" | "activation" | "alerts" | "access";
export type OnboardingStepState = "done" | "pending" | "blocked";

export const ONBOARDING_STEPS: OnboardingStepName[] = [
  "equipment", "device", "mapping", "validation", "activation", "alerts", "access",
];

export interface OnboardingStep {
  step: OnboardingStepName;
  state: OnboardingStepState;
  /** A code, null exactly when `done`. */
  reason: string | null;
  /** The earlier step this one waits on; set only when `blocked` by one. */
  blockedBy: OnboardingStepName | null;
  /** What the state was read from — counts and keys. */
  evidence: Record<string, unknown>;
}

export interface MachineOnboarding {
  machine: { sourceSystem: string; externalId: string; name: string | null; classSlug: string | null; plantId: string | null };
  overall: "done" | "in_progress";
  steps: OnboardingStep[];
}

export interface SiteOnboarding {
  /** Null groups the machines that have no site. */
  site: { id: string; code: string; name: string } | null;
  status: "completed" | "in_progress" | "no_equipment";
  machines: { total: number; done: number; inProgress: number };
  steps: Record<OnboardingStepName, Record<OnboardingStepState, number>>;
}

export interface OnboardingSummary {
  asOf: string;
  sites: SiteOnboarding[];
}

export function apiGetOnboardingSummary(): Promise<OnboardingSummary> {
  return authFetch("/onboarding/status");
}

export function apiGetMachineOnboarding(sourceSystem: string, externalId: string): Promise<MachineOnboarding> {
  return authFetch(
    `/onboarding/status/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}`,
  );
}

// ---------------------------------------------------------------------- thingsshield

/**
 * ThingsShield evidence (`/shield`, `shield.read` / `shield.write`): what was checked on
 * a machine, what was found, and when the next check is due. Status is computed at read
 * time from the latest standing record per category and never stored. A record is never
 * edited: a correction is a new record that supersedes it, once.
 */
export type ShieldCategory = "compliance" | "safety" | "security";
export const SHIELD_CATEGORIES: ShieldCategory[] = ["compliance", "safety", "security"];
export type ShieldResult = "passed" | "failed" | "attention";
export type ShieldStatus = "action_required" | "overdue" | "due_soon" | "current" | "not_recorded";

export interface ShieldEvidence {
  id: string;
  category: ShieldCategory;
  title: string;
  result: ShieldResult;
  performedAt: string;
  dueAt: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  reference: string | null;
  findings: string | null;
  recordedBy: string;
  recordedAt: string;
  supersedesId: string | null;
  /** The record that corrected this one; null while it stands. */
  supersededById: string | null;
}

export interface ShieldMachine {
  machine: { sourceSystem: string; externalId: string; name: string | null; classSlug: string | null; plantId: string | null };
  /** How far ahead "due soon" looks, and whether a parameter or the default set it. */
  dueSoonWindow: { days: number; source: "parameter" | "default"; parameter: { scope: string; scopeRef: string | null } | null };
  categories: Record<ShieldCategory, { status: ShieldStatus; record: ShieldEvidence | null }>;
}

export interface ShieldSummary {
  asOf: string;
  /** Over every (machine, category) cell — a machine with nothing recorded counts three times. */
  counts: Record<ShieldStatus, number>;
  machines: ShieldMachine[];
}

export interface ShieldEvidenceInput {
  title: string;
  result: ShieldResult;
  /** When the check happened. Not in the future. */
  performedAt: string;
  dueAt?: string | null;
  /** At least one of ownerUserId and ownerName. */
  ownerUserId?: string | null;
  ownerName?: string | null;
  reference?: string | null;
  findings?: string | null;
}

export function apiGetShieldSummary(): Promise<ShieldSummary> {
  return authFetch("/shield/summary");
}

/** Every record on the machine, newest check first, corrected ones included and marked. */
export function apiListShieldRecords(sourceSystem: string, externalId: string): Promise<ShieldEvidence[]> {
  return authFetch(`/shield/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/records`);
}

export function apiRecordShieldEvidence(
  sourceSystem: string, externalId: string, input: ShieldEvidenceInput & { category: ShieldCategory },
): Promise<ShieldEvidence> {
  return authFetch(`/shield/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/records`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Correct a record: the original stays. A record is corrected once — a different second
 *  correction is a 409; retrying the same one returns it. */
export function apiReviseShieldEvidence(id: string, input: ShieldEvidenceInput): Promise<ShieldEvidence> {
  return authFetch(`/shield/records/${encodeURIComponent(id)}/revisions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ------------------------------------------------------------------------ incidents

/**
 * Incident Management (`/incidents`). An incident is one machine's live problem, opened
 * by the first alert the evaluator fires on it and gathering the rest: owned, acknowledged,
 * resolved with a note, with SLA clocks from the account's per-severity policy (none set,
 * no clock). Escalation runs server-side.
 */
export type IncidentSeverity = "none" | "low" | "medium" | "high" | "critical";
export const INCIDENT_SEVERITIES: IncidentSeverity[] = ["critical", "high", "medium", "low", "none"];
export type IncidentStatus = "open" | "acknowledged" | "resolved";
export type SlaState = "no_policy" | "on_track" | "met" | "breached";
export type IncidentEventKind =
  | "opened" | "alert_linked" | "severity_raised" | "acknowledged" | "assigned" | "work_raised" | "escalated" | "resolved";

export interface IncidentRecord {
  id: string;
  machine: { sourceSystem: string; externalId: string };
  severity: IncidentSeverity;
  status: IncidentStatus;
  ownerUserId: string | null;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  escalationLevel: number;
  sla: {
    acknowledge: { dueAt: string | null; state: SlaState };
    resolve: { dueAt: string | null; state: SlaState };
  };
}

export interface IncidentDetail extends IncidentRecord {
  alerts: { id: string; severity: string; state: string; firedAt: string; summary: string }[];
  workOrders: { id: string; title: string; status: string; priority: string; assignedToUserId: string | null; alertId: string | null }[];
  timeline: { kind: IncidentEventKind; actor: string; at: string; detail: Record<string, unknown> }[];
}

/** One row per machine with an open alert (the phase-1 view); `incident` is its live record. */
export interface IncidentMachineView {
  machine: { sourceSystem: string; externalId: string; name: string | null; classSlug: string | null; plantId: string | null };
  worstSeverity: IncidentSeverity;
  latestRaisedAt: string;
  /** Same rows the machine page's alert_list shows. */
  openAlerts: PageAlertRow[];
  /** null when the caller may not read work orders — not "none". */
  openWorkOrders: { id: string; status: string; title: string; priority: string }[] | null;
  incident: IncidentRecord | null;
}

export interface IncidentSlaPolicy {
  severity: IncidentSeverity;
  ackWithinMinutes: number;
  resolveWithinMinutes: number;
  updatedBy: string;
  updatedAt: string;
}

export function apiListIncidentView(): Promise<{ status: "open"; incidents: IncidentMachineView[] }> {
  return authFetch("/incidents");
}

export function apiListIncidentRecords(
  filters: { status?: IncidentStatus | "live"; externalId?: string } = {},
): Promise<IncidentRecord[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.externalId) params.set("externalId", filters.externalId);
  const qs = params.toString();
  return authFetch(`/incidents/records${qs ? `?${qs}` : ""}`);
}

export function apiGetIncident(id: string): Promise<IncidentDetail> {
  return authFetch(`/incidents/records/${encodeURIComponent(id)}`);
}

/** Acknowledges its open alerts too. */
export function apiAcknowledgeIncident(id: string): Promise<IncidentRecord> {
  return authFetch(`/incidents/records/${encodeURIComponent(id)}/acknowledge`, { method: "POST" });
}

export function apiAssignIncident(id: string, userId: string | null): Promise<IncidentRecord> {
  return authFetch(`/incidents/records/${encodeURIComponent(id)}/assign`, { method: "POST", body: JSON.stringify({ userId }) });
}

/** Needs a note; resolves its alerts; refused while work raised on them is unfinished. */
export function apiResolveIncident(id: string, note: string): Promise<IncidentRecord> {
  return authFetch(`/incidents/records/${encodeURIComponent(id)}/resolve`, { method: "POST", body: JSON.stringify({ note }) });
}

/** Raised against the incident's worst unresolved alert. */
export function apiRaiseIncidentWorkOrder(
  id: string,
  input: { title: string; description?: string | null; priority?: WorkOrderPriority; assignedToUserId?: string | null; dueAt?: string | null },
): Promise<WorkOrder> {
  return authFetch(`/incidents/records/${encodeURIComponent(id)}/work-orders`, { method: "POST", body: JSON.stringify(input) });
}

export function apiListIncidentSlaPolicies(): Promise<IncidentSlaPolicy[]> {
  return authFetch("/incidents/sla-policies");
}

/** Applies to incidents opened from now on. `parameters.write`. */
export function apiSetIncidentSlaPolicy(
  severity: IncidentSeverity, input: { ackWithinMinutes: number; resolveWithinMinutes: number },
): Promise<IncidentSlaPolicy> {
  return authFetch(`/incidents/sla-policies/${encodeURIComponent(severity)}`, { method: "PUT", body: JSON.stringify(input) });
}

export function apiDeleteIncidentSlaPolicy(severity: IncidentSeverity): Promise<void> {
  return authFetch(`/incidents/sla-policies/${encodeURIComponent(severity)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------- fleet onboarding

/**
 * Bringing a 1.0 customer's existing fleet into 2.0's register from the mirror
 * (`/inventory/fleet-onboarding/:tenantId`, Things Alive staff, `device.manage`). Read the
 * plan, then apply: apply recomputes inside its own transaction, only ever adds, and is
 * idempotent. Conflicts are listed, never resolved. It does not bind signals.
 */
export type FleetConflictReason =
  | "held_by_another_account" | "retired" | "claimed_to_another_machine" | "machine_not_in_projection";

export interface FleetOnboardingPlan {
  tenantId: string;
  /** 1.0 machines with no register row; created `origin: 'mirrored'`, unclassified. */
  createMachines: { sourceSystem: string; externalId: string; name: string | null }[];
  /** 1.0 loggers 2.0 has never seen: registered, assigned to the account and fitted. */
  registerDevices: { imei: string; sourceSystem: string; equipmentExternalId: string }[];
  /** Loggers already in the account but on no machine: fitted to the one 1.0 says. */
  claimDevices: { imei: string; sourceSystem: string; equipmentExternalId: string }[];
  alreadyOnboarded: number;
  conflicts: { imei: string; equipmentExternalId: string; reason: FleetConflictReason; detail: string }[];
}

export function apiGetFleetOnboardingPlan(tenantId: string): Promise<FleetOnboardingPlan> {
  return authFetch(`/inventory/fleet-onboarding/${encodeURIComponent(tenantId)}`);
}

export function apiApplyFleetOnboarding(tenantId: string): Promise<FleetOnboardingPlan & { applied: true }> {
  return authFetch(`/inventory/fleet-onboarding/${encodeURIComponent(tenantId)}/apply`, { method: "POST" });
}

// ------------------------------------------------------------- chain diagnosis / what-if

/**
 * What a machine's causal chains say about it now (`/intelligence/diagnose/...`,
 * `prediction.read`), and where a chain ends up if its inputs go where you say
 * (`/intelligence/chains/:slug/project`). A stage is scored against what its own
 * drivers predict, so the first stage off its curve — the origin — is the thing to look at.
 */
export type StageVerdict = "normal" | "origin" | "additional" | "unevaluated";

export interface ChainStageResult {
  signal: string;
  label?: string;
  verdict: StageVerdict;
  reason?: "no-target" | "driver-missing" | "out-of-range";
  missingDrivers?: string[];
  at?: number;
  actual?: number;
  expected?: number;
  /** actual - expected, signed. */
  residual?: number;
  /** Residual over warnAbove in the fault direction; 1 is exactly at the threshold. */
  exceedance?: number;
  severity?: "none" | "warning" | "critical";
  drivers?: Record<string, number>;
}

export interface ChainDiagnosisResult {
  slug: string;
  evaluated: boolean;
  reason?: "no-nodes" | "cycle" | "nothing-evaluable";
  confidence: string;
  stages: ChainStageResult[];
  origin?: ChainStageResult;
  additional: ChainStageResult[];
  /** Downstream stages whose rise the origin fully explains. */
  explainedBy?: { signal: string; because: string }[];
}

export interface MachineDiagnosis {
  sourceSystem: string;
  externalId: string;
  equipmentClassSlug: string | null;
  chains: ChainDiagnosisResult[];
  skipped: { slug: string; reason: string }[];
}

export interface ProjectedStage {
  signal: string;
  label?: string;
  expected: number;
  /** Seconds from now before this stage has finished responding. */
  leadSeconds: number;
  depth: number;
  /** null when the stage has no rating to breach — "not configured", not "within limits". */
  breach: "none" | "warning" | "critical" | null;
  confidence: string;
}

export interface ChainProjection {
  slug: string;
  projected: boolean;
  reason?: "no-nodes" | "cycle" | "no-inputs";
  stages: ProjectedStage[];
  firstBreach?: ProjectedStage;
}

export function apiDiagnoseMachine(sourceSystem: string, externalId: string): Promise<MachineDiagnosis> {
  return authFetch(`/intelligence/diagnose/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}`);
}

export function apiProjectChain(slug: string, inputs: { signal: string; value: number }[]): Promise<ChainProjection> {
  return authFetch(`/intelligence/chains/${encodeURIComponent(slug)}/project`, {
    method: "POST",
    body: JSON.stringify({ inputs }),
  });
}

// -------------------------------------------------------------------- class visuals

/**
 * A class's schematic image and the signal anchors placed on it (QREC0c). Master Admin
 * authors it on a draft class version (`/platform/catalog/equipment-classes/:slug/:version`,
 * `catalog.write`): the image goes straight to object storage through a short-lived
 * presigned PUT, then is confirmed with the dimensions the console measured. Each account
 * can move or add anchors on its own copy (`/my-catalog/...`) but not change the image.
 */
export type VisualState = "ready" | "no_visual" | "upload_pending" | "assets_unavailable";
export const VISUAL_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
export const MAX_VISUAL_BYTES = 50 * 1024 * 1024;

export interface VisualAnchor {
  signal: string;
  /** Percent of the image's width and height, 0..100. */
  hotspotX: number;
  hotspotY: number;
  label: string | null;
}

export interface ClassVisual {
  classSlug: string;
  classVersion: number;
  state: VisualState;
  tier: "schematic" | null;
  imageUrl: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  anchors: VisualAnchor[];
  unplacedSignals: string[];
}

export interface TenantVisual {
  classSlug: string;
  state: VisualState;
  imageUrl: string | null;
  width: number | null;
  height: number | null;
  /** placementCustom: the account moved or added it; a new class version never moves it. */
  anchors: (VisualAnchor & { placementCustom: boolean })[];
  unplacedSignals: string[];
}

const classVisualPath = (slug: string, version: number) =>
  `/platform/catalog/equipment-classes/${encodeURIComponent(slug)}/${version}`;

export function apiGetClassVisual(slug: string, version: number): Promise<ClassVisual> {
  return authFetch(`${classVisualPath(slug, version)}/visual`);
}

export function apiRequestClassVisualUpload(
  slug: string, version: number, contentType: string,
): Promise<{ uploadUrl: string; key: string; method: "PUT"; headers: Record<string, string>; expiresInSeconds: number }> {
  return authFetch(`${classVisualPath(slug, version)}/visual/upload-url`, {
    method: "POST",
    body: JSON.stringify({ contentType }),
  });
}

/** Records the uploaded image; the API never sees the bytes, so the console sends the size it measured. */
export function apiConfirmClassVisual(slug: string, version: number, width: number, height: number): Promise<ClassVisual> {
  return authFetch(`${classVisualPath(slug, version)}/visual/confirm`, {
    method: "POST",
    body: JSON.stringify({ width, height }),
  });
}

/** Draft versions only. The stored object is kept. */
export function apiDeleteClassVisual(slug: string, version: number): Promise<void> {
  return authFetch(`${classVisualPath(slug, version)}/visual`, { method: "DELETE" });
}

/** Replaces the whole set, validated as a set. */
export function apiSetClassAnchors(slug: string, version: number, anchors: VisualAnchor[]): Promise<ClassVisual> {
  return authFetch(`${classVisualPath(slug, version)}/anchors`, { method: "PUT", body: JSON.stringify({ anchors }) });
}

export function apiGetMyClassVisual(slug: string): Promise<TenantVisual> {
  return authFetch(`/my-catalog/equipment-classes/${encodeURIComponent(slug)}/visual`);
}

/** Moved or added anchors become the account's own. */
export function apiSetMyClassAnchors(slug: string, anchors: VisualAnchor[]): Promise<TenantVisual> {
  return authFetch(`/my-catalog/equipment-classes/${encodeURIComponent(slug)}/anchors`, {
    method: "PUT",
    body: JSON.stringify({ anchors }),
  });
}

// ---------------------------------------------------------------- telemetry archive

/**
 * Telemetry past 90 days, exported to Parquet per account and month, verified by reading
 * the object back, then dropped (QARCH1). Things Alive staff only (`platform.admin`).
 * Read-only here: running a pass stays an operations action, not a console button.
 */
export interface TelemetryArchiveRow {
  id: string;
  tenantId: string;
  /** First day of the month archived. */
  month: string;
  part: number;
  objectKey: string;
  /** bigint columns arrive as strings. */
  rowCount: string;
  checksum: string;
  byteSize: string;
  exportedAt: string;
  verifiedAt: string | null;
  verifyError: string | null;
}

/** Raw rows of `telemetry_partition_drop`, so snake_case. */
export interface TelemetryPartitionDrop {
  partition_name: string;
  month: string;
  rows_dropped: string;
  proved_by: unknown;
  dropped_at: string;
}

export function apiListTelemetryArchives(): Promise<{ archives: TelemetryArchiveRow[]; drops: TelemetryPartitionDrop[] }> {
  return authFetch("/platform/telemetry-archives");
}

// ---------------------------------------------------------------- assistant

/**
 * The Ask AI widget and the onboarding chat (QCHAT1). The browser holds the
 * conversation and sends it back each turn; the server keeps nothing but the day's
 * spend. Up to 20 messages of up to 2,000 characters each. Answers inside one
 * account only: a platform user gets 403, and a server with no model configured 503.
 */
export interface AssistantMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AssistantReply {
  reply: string;
  /** The lookups the answer rests on, e.g. "list_alerts". */
  toolsUsed: string[];
  /** False when the step limit was reached before the model finished. */
  complete: boolean;
  tokens: number;
  budget: { usedToday: number; dailyLimit: number };
}

export type AssistantProposalKind = "create_site" | "create_equipment" | "fit_logger";
export type AssistantProposalStatus = "proposed" | "applied" | "failed" | "rejected" | "expired";

export interface AssistantProposal {
  id: string;
  kind: AssistantProposalKind;
  payload: Record<string, unknown>;
  /** The sentence the person approves, written from the payload, not by the model. */
  summary: string;
  status: AssistantProposalStatus;
  proposedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

export function apiAssistantChat(messages: AssistantMessage[]): Promise<AssistantReply> {
  return authFetch("/assistant/chat", { method: "POST", body: JSON.stringify({ messages }) });
}

export function apiAssistantOnboardingChat(
  messages: AssistantMessage[],
): Promise<AssistantReply & { proposals: AssistantProposal[] }> {
  return authFetch("/assistant/onboarding/chat", { method: "POST", body: JSON.stringify({ messages }) });
}

export function apiListAssistantProposals(status?: AssistantProposalStatus): Promise<AssistantProposal[]> {
  return authFetch(`/assistant/proposals${status ? `?status=${status}` : ""}`);
}

/** Does what was proposed, as the signed-in user. Idempotent: returns the decided proposal. */
export function apiConfirmAssistantProposal(id: string): Promise<AssistantProposal> {
  return authFetch(`/assistant/proposals/${id}/confirm`, { method: "POST" });
}

export function apiRejectAssistantProposal(id: string): Promise<AssistantProposal> {
  return authFetch(`/assistant/proposals/${id}/reject`, { method: "POST" });
}

// ---------------------------------------------------------------- workflows

/**
 * Alert workflows (QWF1). A workflow is a graph of the alert runtime's own conditions;
 * publishing compiles it into ordinary alert rules, so nothing here is a second engine.
 * Reads need `prediction.read`, writes `alert.author`. Only a draft version can change;
 * editing a published workflow starts a new draft from it.
 */
export type WorkflowNodeType =
  | "ReadSignal" | "Threshold" | "FreshnessGate" | "PredictionSeverity" | "FuelLoss" | "ChainOrigin"
  | "AllOf" | "AnyOf" | "Notify";

export interface WorkflowSpecNode {
  id: string;
  type: WorkflowNodeType;
  params?: Record<string, string | number | boolean | null>;
}

export interface WorkflowScope {
  appliesTo: "account" | "plant" | "equipment" | "equipment-class";
  plantId?: string | null;
  sourceSystem?: string | null;
  externalId?: string | null;
  equipmentClassSlug?: string | null;
}

export interface WorkflowSpec {
  kind: "alert";
  scope: WorkflowScope;
  nodes: WorkflowSpecNode[];
  edges: { from: string; to: string }[];
}

export type WorkflowVersionStatus = "draft" | "published" | "superseded" | "retired";

export interface WorkflowVersion {
  id: string;
  version: number;
  status: WorkflowVersionStatus;
  source: string;
  graphHash: string;
  publishedAt: string | null;
  publishedBy: string | null;
  spec: WorkflowSpec;
  /** Node id → canvas position. Never part of the graph's meaning. */
  layout: Record<string, { x: number; y: number }>;
  /** The compiled rules read back in plain English; empty when the spec does not compile. */
  rendering: string[];
  /** The alert rules this version wrote, and which are switched off. */
  rules: { id: string; slug: string; name: string; enabled: boolean }[];
}

export interface Workflow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: "alert";
  createdAt: string;
  updatedAt: string;
  versions: WorkflowVersion[];
}

export interface WorkflowMachineReadiness {
  machine: { sourceSystem: string; externalId: string; name: string | null };
  state: "ready" | "not_configured" | "blocked";
  signals: { signal: string; state: "ready" | "not_configured" | "blocked"; reason: "unbound" | "stale" | "no_readings" | null }[];
}

export interface WorkflowCompileResult {
  graphHash: string;
  rules: { slug: string; name: string; severity: string; rendering: string }[];
  rendering: string[];
  readiness: WorkflowMachineReadiness[];
  /** Null when publish would go ahead; otherwise the sentence saying why it would not. */
  publishRefusal: string | null;
}

export function apiListWorkflows(): Promise<Workflow[]> {
  return authFetch("/workflows");
}

export function apiGetWorkflow(id: string): Promise<Workflow> {
  return authFetch(`/workflows/${id}`);
}

/** The workflow and its draft version 1. The spec must already compile. */
export function apiCreateWorkflow(input: { slug: string; name: string; description?: string; spec: WorkflowSpec }): Promise<Workflow> {
  return authFetch("/workflows", { method: "POST", body: JSON.stringify(input) });
}

export function apiReplaceWorkflowSpec(id: string, version: number, spec: WorkflowSpec): Promise<Workflow> {
  return authFetch(`/workflows/${id}/versions/${version}/spec`, { method: "PUT", body: JSON.stringify({ spec }) });
}

export function apiSetWorkflowLayout(id: string, version: number, positions: Record<string, { x: number; y: number }>): Promise<unknown> {
  return authFetch(`/workflows/${id}/versions/${version}/layout`, { method: "PUT", body: JSON.stringify({ positions }) });
}

/** Dry run: the rules publish would write, read back, and whether each machine could fire. Writes nothing. */
export function apiCompileWorkflow(id: string, version: number): Promise<WorkflowCompileResult> {
  return authFetch(`/workflows/${id}/versions/${version}/compile`, { method: "POST" });
}

/** Compile and write the rules. Idempotent; 409 with the reason when nothing it covers could fire. */
export function apiPublishWorkflow(id: string, version: number): Promise<{ version: number; status: string; alreadyPublished: boolean }> {
  return authFetch(`/workflows/${id}/versions/${version}/publish`, { method: "POST" });
}

/** Switches every compiled rule off and retires the published version. The rules stay, off. */
export function apiRetireWorkflow(id: string): Promise<Workflow> {
  return authFetch(`/workflows/${id}/retire`, { method: "POST" });
}

/** A new draft copied from the published version; 409 when a draft already exists. */
export function apiNewWorkflowVersion(id: string): Promise<Workflow> {
  return authFetch(`/workflows/${id}/versions`, { method: "POST" });
}

// ---------------------------------------------------------------- fleet import (bulk upload)

/**
 * Bulk upload of a client's machines and logger fittings from an Excel workbook
 * (`/fleet-import`, `equipment.write`; a Devices sheet also needs `device.claim`).
 * Plan writes nothing; apply rebuilds the plan itself, only adds, and is refused whole
 * while any row has an error. No batch is stored: the same file goes to both, and
 * uploading it again is how a retry works. Things Alive staff name the account.
 */
export type FleetImportConflictReason = "not_in_this_account" | "not_assigned" | "claimed_to_another_machine";

export interface FleetImportPlan {
  tenantId: string;
  /** False while any row has an error; apply refuses the whole workbook until it is true. */
  canApply: boolean;
  equipment: {
    create: { row: number; code: string; name: string; siteCode: string | null; equipmentClassSlug: string | null }[];
    /** Already in the register with exactly these values. */
    unchanged: number;
    /** Already in the register with different values: listed, never overwritten. */
    conflicts: { row: number; code: string; fields: string[]; detail: string }[];
    errors: { row: number; message: string }[];
  };
  devices: {
    claim: { row: number; imei: string; sourceSystem: string; equipmentCode: string }[];
    alreadyClaimed: number;
    conflicts: { row: number; imei: string; reason: FleetImportConflictReason; detail: string }[];
    errors: { row: number; message: string }[];
  };
}

export async function apiDownloadFleetImportTemplate(): Promise<Blob> {
  const res = await authFetchRaw("/fleet-import/template");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body?.error?.message ?? "Could not download the template.", res.status);
  }
  return res.blob();
}

async function postFleetWorkbook(step: "plan" | "apply", file: File, tenantId?: string): Promise<FleetImportPlan> {
  const form = new FormData();
  form.append("file", file);
  const res = await authFetchRaw(`/fleet-import/${step}${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ""}`, {
    method: "POST",
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body?.error?.message ?? "Could not read the workbook.", res.status);
  return body;
}

/** What the workbook would add, row by row, with every error and conflict. Writes nothing. */
export function apiPlanFleetImport(file: File, tenantId?: string): Promise<FleetImportPlan> {
  return postFleetWorkbook("plan", file, tenantId);
}

/** Adds the machines and fits the loggers. Idempotent; refused whole on any row error. */
export function apiApplyFleetImport(file: File, tenantId?: string): Promise<FleetImportPlan & { applied: true }> {
  return postFleetWorkbook("apply", file, tenantId) as Promise<FleetImportPlan & { applied: true }>;
}

// ---------------------------------------------------------------- recommendations

/**
 * The recommendation evidence for one machine (QREC1) and its framing in sentences
 * (QREC2), `prediction.read`. Running the evidence writes only a derived, immutable
 * record, and returns the existing one when nothing it read has changed. A frame is
 * rendered by a POST and only read by a GET: the page never renders on read.
 */
export type RecBundleStatus = "ready" | "not_configured" | "blocked";
export type RecBundleOutcome = "attributed" | "unattributed" | "inconclusive" | "nothing_detected";

export interface RecEvidenceBundle {
  id: string;
  sourceSystem: string;
  externalId: string;
  asOf: string;
  engineVersion: string;
  classSlug: string | null;
  status: RecBundleStatus;
  /** Why a bundle is not ready: unclassified, class_not_in_account, no_library_content, insufficient_coverage. */
  reason: string | null;
  outcome: RecBundleOutcome | null;
  /** Typed only as far as the panel reads it: which expected signals were seen. */
  detect: { coverage?: { expected?: string[]; observed?: string[] } } & Record<string, unknown>;
  createdAt: string;
}

/** GroundedAnswerV1 (docs/ai/contracts/grounded-answer.v1.schema.json). */
export interface GroundedAnswer {
  answer_id: string;
  context_id: string;
  status: "answered" | "partial" | "needs_input" | "insufficient_evidence" | "unavailable";
  summary: string;
  observations: { claim: string; evidence_refs: string[] }[];
  hypotheses: { claim: string; evidence_refs: string[]; limitations: string[] }[];
  next_steps: { aim: string; expected_outcome: string; required_capability: string; simulation_available: boolean }[];
  citations: unknown[];
  missing_inputs: string[];
  as_of: string;
  limitations: string[];
}

export interface RecFrame {
  answer: GroundedAnswer;
  provenance: { renderer: "template" | "model"; rendererVersion: string; modelId: string | null; modelVersion: string | null; bundleId: string };
}

const recPath = (sourceSystem: string, externalId: string) =>
  `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/rec-evidence`;

/** Run the five steps now. Idempotent: unchanged evidence returns the existing bundle. */
export function apiRunRecEvidence(sourceSystem: string, externalId: string): Promise<RecEvidenceBundle> {
  return authFetch(recPath(sourceSystem, externalId), { method: "POST" });
}

/** The latest bundle; 404 when this machine has never been evaluated. */
export function apiGetLatestRecEvidence(sourceSystem: string, externalId: string): Promise<RecEvidenceBundle> {
  return authFetch(recPath(sourceSystem, externalId));
}

/** Frame a bundle in sentences. Idempotent: one stored frame per bundle per template version. */
export function apiRenderRecFrame(bundleId: string): Promise<RecFrame> {
  return authFetch(`/rec-evidence/${bundleId}/frame`, { method: "POST" });
}

/** The served frame; 404 when none has been rendered for this bundle. */
export function apiGetRecFrame(bundleId: string): Promise<RecFrame> {
  return authFetch(`/rec-evidence/${bundleId}/frame`);
}

export interface WorkflowAssembleResult {
  spec: WorkflowSpec;
  /** The assembled rules in plain English; empty when nothing could be assembled. */
  rendering: string[];
  /** What the library could not supply: a signal no copied template watches, never given an invented threshold. */
  unresolved: { signal?: string; templateSlug?: string; reason: "no_copied_template" | "template_not_copied" | "class_unknown"; detail: string }[];
}

/**
 * A spec from a failure mode and/or chosen alert templates, out of this account's own
 * copied templates (QWF1 §5). Writes nothing; the result opens in the editor like any draft.
 */
export function apiAssembleWorkflow(input: {
  target: WorkflowScope;
  failureModeCode?: string;
  alertTemplateSlugs?: string[];
  combine?: "allOf" | "anyOf";
}): Promise<WorkflowAssembleResult> {
  return authFetch("/workflows/assemble", { method: "POST", body: JSON.stringify(input) });
}

// ---------------------------------------------------------------- class 3-D model

/**
 * The class's 3-D model and its signal markers (QTWIN1), beside the schematic and on the
 * same rules: a draft version takes a new model and markers, a published one is read
 * only. The bytes go straight to storage with a presigned PUT; confirm sends the bounding
 * box the browser measured, and a marker outside that box is refused. Each account can
 * move or add markers on its own copy, and confirms a marker the geometry changed under.
 */
export type ModelState = "ready" | "no_model" | "upload_pending" | "assets_unavailable";
export const MODEL_CONTENT_TYPES = ["model/gltf-binary"];

export interface ModelBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ModelAnchor {
  signal: string;
  x: number;
  y: number;
  z: number;
  label: string | null;
}

export interface ClassModel {
  classSlug: string;
  classVersion: number;
  state: ModelState;
  modelUrl: string | null;
  contentType: string | null;
  geometryVersion: number | null;
  bounds: ModelBounds | null;
  anchors: ModelAnchor[];
  unplacedSignals: string[];
}

export interface TenantModel {
  classSlug: string;
  state: ModelState;
  modelUrl: string | null;
  contentType: string | null;
  geometryVersion: number | null;
  bounds: ModelBounds | null;
  /** placementCustom: the account moved or added it. needsRecheck: the geometry changed under it. */
  anchors: (ModelAnchor & { placementCustom: boolean; needsRecheck: boolean })[];
  /** What is not drawn: signals with no marker, and markers waiting for a recheck. */
  tray: { signal: string; needsRecheck: boolean }[];
}

const classModelPath = (slug: string, version: number) =>
  `/platform/catalog/equipment-classes/${encodeURIComponent(slug)}/${version}/model`;

export function apiGetClassModel(slug: string, version: number): Promise<ClassModel> {
  return authFetch(classModelPath(slug, version));
}

export function apiRequestClassModelUpload(
  slug: string, version: number, contentType: string,
): Promise<{ uploadUrl: string; key: string; method: "PUT"; headers: Record<string, string>; expiresInSeconds: number }> {
  return authFetch(`${classModelPath(slug, version)}/upload-url`, { method: "POST", body: JSON.stringify({ contentType }) });
}

/** geometryChanged false keeps the geometry version (and every account's markers) only if the box is unchanged too. */
export function apiConfirmClassModel(slug: string, version: number, bounds: ModelBounds, geometryChanged: boolean): Promise<ClassModel> {
  return authFetch(`${classModelPath(slug, version)}/confirm`, {
    method: "POST",
    body: JSON.stringify({ boundsMin: bounds.min, boundsMax: bounds.max, geometryChanged }),
  });
}

export function apiDeleteClassModel(slug: string, version: number): Promise<void> {
  return authFetch(classModelPath(slug, version), { method: "DELETE" });
}

export function apiSetClassModelAnchors(slug: string, version: number, anchors: ModelAnchor[]): Promise<ClassModel> {
  return authFetch(`${classModelPath(slug, version)}/anchors`, { method: "PUT", body: JSON.stringify({ anchors }) });
}

const myModelPath = (slug: string) => `/my-catalog/equipment-classes/${encodeURIComponent(slug)}/model`;

export function apiGetMyClassModel(slug: string): Promise<TenantModel> {
  return authFetch(myModelPath(slug));
}

export function apiSetMyClassModelAnchors(slug: string, anchors: ModelAnchor[]): Promise<TenantModel> {
  return authFetch(`${myModelPath(slug)}/anchors`, { method: "PUT", body: JSON.stringify({ anchors }) });
}

export function apiConfirmMyModelAnchor(slug: string, signal: string): Promise<TenantModel> {
  return authFetch(`${myModelPath(slug)}/anchors/${encodeURIComponent(signal)}/confirm`, { method: "POST" });
}

// ---------------------------------------------------------------- generated drafts

/**
 * Generated drafts (QGEN1-3): an alert workflow or a KPI the platform assembles from a
 * closed list of intents, compiles, gates (a workflow by a 90-day replay per machine)
 * and holds until the account's super admin approves it, which is what makes it real.
 * A proposal that lacks a selection answers `needs_input` naming each missing field.
 */
export type ProposalKind = "kpi" | "workflow";
export type ProposalStatus =
  | "proposed" | "compile_refused" | "compiled" | "gate_refused" | "draft_ready"
  | "approved" | "rejected" | "materialised" | "expired";
export type GateOutcome = "pass" | "refuse" | "insufficient_history" | "not_applicable";

export interface ProposalIntent {
  intent: string;
  name: string;
  description: string;
  requiredFields: string[];
  optionalFields: string[];
}

export interface ProposalReplayRun {
  id: string;
  proposalId: string;
  sourceSystem: string;
  externalId: string;
  windowFrom: string;
  windowTo: string;
  compilerVersion: string;
  signals: Record<string, unknown>[];
  windowsEvaluated: number;
  fires: number;
  outcome: Exclude<GateOutcome, "not_applicable">;
  outcomeReason: string;
  startedAt: string;
  finishedAt: string;
}

export interface Proposal {
  id: string;
  kind: ProposalKind;
  scope: "tenant" | "class";
  status: ProposalStatus;
  gateOutcome: GateOutcome | null;
  /** Never "ready" for a draft nobody may switch on. */
  readiness: "ready" | "pending" | "blocked";
  reason: string | null;
  /** One plain sentence on where it stands. */
  sentence: string;
  /** The gate had too little history: approving it creates its rules switched off. */
  unvalidated: boolean;
  expired: boolean;
  expiresAt: string;
  seed: Record<string, unknown>;
  target: Record<string, unknown>;
  targetVersions: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** What it would do, in plain English. */
  rendering: string[];
  compileResult: Record<string, unknown> | null;
  gateDetail: Record<string, unknown> | null;
  provenance: { emitterKind: string; emitterVersion: string; proposedBy: string; proposedAt: string } & Record<string, unknown>;
  approval: { by: string; at: string } | null;
  rejection: { by: string; at: string; reason: string | null } | null;
  /** What approval created: a workflow and its rules, or a client formula. */
  materialisedRef: ({ workflowId?: string; ruleIds?: string[] } & Record<string, unknown>) | null;
  replayRuns?: ProposalReplayRun[];
}

export type ProposeResult = Proposal | { status: "needs_input"; missing: { field: string; reason: string; detail: string }[] };
export const needsInput = (r: ProposeResult): r is Extract<ProposeResult, { status: "needs_input" }> => r.status === "needs_input";

export function apiListWorkflowProposalIntents(): Promise<ProposalIntent[]> {
  return authFetch("/workflow-proposal-intents");
}

export function apiListKpiProposalIntents(): Promise<ProposalIntent[]> {
  return authFetch("/kpi-proposal-intents");
}

/** `alert.author`. The target must be one machine for now. */
export function apiProposeWorkflow(seed: Record<string, unknown>): Promise<ProposeResult> {
  return authFetch("/workflow-proposals", { method: "POST", body: JSON.stringify(seed) });
}

export function apiProposeKpi(sourceSystem: string, externalId: string, seed: Record<string, unknown>): Promise<ProposeResult> {
  return authFetch(`/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/kpi-proposals`, {
    method: "POST", body: JSON.stringify(seed),
  });
}

export function apiListProposals(filter: { kind?: ProposalKind; status?: ProposalStatus } = {}): Promise<Proposal[]> {
  const params = new URLSearchParams();
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.status) params.set("status", filter.status);
  const qs = params.toString();
  return authFetch(`/proposals${qs ? `?${qs}` : ""}`);
}

export function apiGetProposal(id: string): Promise<Proposal> {
  return authFetch(`/proposals/${id}`);
}

/** One machine's replay, with every window that fired. */
export function apiGetProposalReplayRun(id: string, runId: string): Promise<ProposalReplayRun & { firesDetail: Record<string, unknown> }> {
  return authFetch(`/proposals/${id}/replay-runs/${runId}`);
}

/** `proposal.approve`. Rechecks scope, expiry and versions; 409 names a failed recheck. Idempotent. */
export function apiApproveProposal(id: string): Promise<Proposal> {
  return authFetch(`/proposals/${id}/approve`, { method: "POST" });
}

export function apiRejectProposal(id: string, reason?: string): Promise<Proposal> {
  return authFetch(`/proposals/${id}/reject`, { method: "POST", body: JSON.stringify(reason ? { reason } : {}) });
}

/** `alert.author`. Switch on a rule an unvalidated draft created, recording who chose to. */
export function apiEnableProposalRule(id: string, ruleId: string): Promise<unknown> {
  return authFetch(`/proposals/${id}/rules/${ruleId}/enable`, { method: "POST" });
}

/** Published library formulas, newest published version of each: what a KPI draft can bind. */
export function apiListPublishedNamedFormulas(): Promise<NamedFormula[]> {
  return authFetch("/catalog/named-formulas");
}

// ---------------------------------------------------------------- geofence fleet map (QGEO2)
// Shape: docs/ai/contracts/geofence/fleet-status.v1.schema.json. Positions are
// [longitude, latitude], as GeoJSON has them.

export type GeofenceShape =
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "Circle"; center: [number, number]; radiusM: number }
  | { type: "Corridor"; path: [number, number][]; widthM: number };

export interface GeofenceFleetZone {
  key: string;
  id: string | null;
  source: "zone" | "site-boundary";
  code: string;
  name: string;
  kind: "allowed" | "restricted" | "corridor";
  shape: GeofenceShape;
  appliesTo: string;
}

export interface GeofenceFleetMachine {
  sourceSystem: string;
  externalId: string;
  name: string | null;
  site: { id: string; code: string; name: string } | null;
  position: { lng: number; lat: number; at: string; ageSeconds: number; imei: string } | null;
  positionStatus: "live" | "stale" | "none";
  zones: { key: string; inside: boolean; violation: boolean }[];
  violating: boolean;
}

export interface GeofenceFleetStatus {
  asOf: string;
  zones: GeofenceFleetZone[];
  machines: GeofenceFleetMachine[];
  summary: { machines: number; live: number; stale: number; noPosition: number; violating: number };
}

/** Every machine's latest position against its fences, for the fleet map. */
export function apiGeofenceFleetStatus(siteId?: string): Promise<GeofenceFleetStatus> {
  return authFetch(`/geofences/fleet-status${siteId ? `?siteId=${encodeURIComponent(siteId)}` : ""}`);
}

/** A zone as authored (GET /geofences): disabled ones included, unlike the fleet map's. */
export interface GeofenceZoneRecord {
  id: string;
  code: string;
  name: string;
  kind: "allowed" | "restricted" | "corridor";
  shape: GeofenceShape;
  appliesTo: "account" | "plant" | "equipment" | "equipment-class";
  plantId: string | null;
  sourceSystem: string | null;
  externalId: string | null;
  equipmentClassSlug: string | null;
  enabled: boolean;
}

export interface GeofenceZoneInput {
  code: string;
  name: string;
  kind: GeofenceZoneRecord["kind"];
  shape: GeofenceShape;
  appliesTo: GeofenceZoneRecord["appliesTo"];
  plantId?: string;
  sourceSystem?: string;
  externalId?: string;
  equipmentClassSlug?: string;
}

export function apiListGeofences(): Promise<GeofenceZoneRecord[]> {
  return authFetch("/geofences");
}

export function apiCreateGeofence(input: GeofenceZoneInput): Promise<GeofenceZoneRecord> {
  return authFetch("/geofences", { method: "POST", body: JSON.stringify(input) });
}

/** Code and target never change after creation (the backend refuses it); a new target is a new zone. */
export function apiUpdateGeofence(
  id: string, patch: { name?: string; kind?: GeofenceZoneRecord["kind"]; shape?: GeofenceShape; enabled?: boolean },
): Promise<GeofenceZoneRecord> {
  return authFetch(`/geofences/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function apiDeleteGeofence(id: string): Promise<{ id: string; deleted: true }> {
  return authFetch(`/geofences/${encodeURIComponent(id)}`, { method: "DELETE" });
}

