/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The first slice of real backend integration: sign-in, session refresh and
// sign-out against Platform 2.0's actual /auth routes. Every other screen in
// this app still reads and writes mock data — see App.tsx.

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
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401 && !retried) {
    const resumed = await apiResume();
    if (resumed) return authFetch(path, init, true);
    // The refresh token is genuinely dead, not just this access token. Force the
    // rest of the app to notice now, rather than parsing this one response as an
    // ordinary error and leaving `authUser` pointing at a session that no longer
    // exists.
    onSessionDead?.();
  }
  return parse(res);
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

// ------------------------------------------------------------------------- plants

/**
 * A site inside the signed-in client's own account — GET /equipment/plants and
 * friends. There is no cross-tenant equivalent: a plant belongs to whichever
 * tenant is asking, decided by the session, never by a client picker. Master
 * Admin has no plants of their own to see or manage here.
 */
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

export function apiListPlants(includeRetired = true): Promise<Plant[]> {
  return authFetch(
    `/equipment/plants${includeRetired ? "?includeRetired=true" : ""}`,
  );
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
}

export function apiListEquipment(
  filters: { plantId?: string; includeRetired?: boolean } = {},
): Promise<EquipmentProfile[]> {
  const params = new URLSearchParams();
  if (filters.plantId) params.set("plantId", filters.plantId);
  if (filters.includeRetired) params.set("includeRetired", "true");
  const qs = params.toString();
  return authFetch(`/equipment${qs ? `?${qs}` : ""}`);
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
 *  reason — this is the edit that changes who can see the asset. */
export function apiMoveEquipment(
  sourceSystem: string,
  externalId: string,
  toPlantId: string | null,
  reason: string,
): Promise<EquipmentProfile> {
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/move`,
    { method: "POST", body: JSON.stringify({ toPlantId, reason }) },
  );
}

/** There is no hard delete — a machine leaves its site and stops counting as
 *  active, but the row (and its placement/binding history) stays. */
export function apiRetireEquipment(
  sourceSystem: string,
  externalId: string,
  reason: string,
): Promise<EquipmentProfile> {
  return authFetch(
    `/equipment/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/retire`,
    { method: "POST", body: JSON.stringify({ reason }) },
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

// -------------------------------------------------------------- alert rule templates

/**
 * What Things Alive knows is worth alerting on, for a class (POST/PATCH
 * /catalog/alert-templates and friends, `catalog.write` — Things Alive only).
 * Granting the class copies these into the account as the client's own `AlertRule`
 * rows, which the client then owns and edits — this file has no route for that copy,
 * only for the template it was copied from.
 *
 * Only the two triggers a class-level template author can meaningfully set up without
 * a live machine in front of them are modelled here: a threshold against one of the
 * class's expected signals, or "this scenario said so". `no-telemetry` needs no
 * params. `fuel-loss` and `chain-origin` need a GPS fix and a causal chain
 * respectively — neither exists in this authoring context, so they're left out of the
 * picker rather than half-modelled.
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

export type AlertParams =
  | PredictionSeverityParams
  | SignalThresholdParams
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
}

export interface CatalogImportApplySummary {
  classes: Record<string, ClassApplyResult>;
  sensorCapabilities: { created: number; skipped: number };
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
): Promise<CatalogImportApplySummary> {
  return authFetch(
    `/platform/catalog/imports/${encodeURIComponent(id)}/apply`,
    { method: "POST" },
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
}

export interface SensorParameterSpec {
  parameter: string;
  unit: string;
  min: number;
  max: number;
  normalRange: string;
  notes?: string;
}

export interface Sensor {
  id: string;
  sensorName: string;
  categoryId: string | null;
  description: string | null;
  protocol: string | null;
  parameterSpecs: SensorParameterSpec[];
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

export function apiListSensorCategories(): Promise<SensorCategory[]> {
  return authFetch("/device-catalog/categories");
}

export function apiCreateSensorCategory(name: string): Promise<SensorCategory> {
  return authFetch("/device-catalog/categories", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function apiListSensors(): Promise<Sensor[]> {
  return authFetch("/device-catalog/sensors");
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

/** A sensor mapped onto a tool profile, resolved to its name — never stored, only read. */
export interface ResolvedMappedSensor {
  sensorId: string;
  sensorName: string;
  parameters: string[];
}

export interface ToolMapping {
  id: string;
  toolName: string;
  industryType: string | null;
  protocol: string | null;
  mappedSensors: ResolvedMappedSensor[];
  createdAt: string;
  updatedAt: string;
}

export interface ToolMappingInput {
  toolName?: string;
  industryType?: string;
  protocol?: string;
  mappedSensors?: { sensorId: string; parameters: string[] }[];
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

export function apiUpdateToolMapping(
  id: string,
  input: ToolMappingInput,
): Promise<ToolMapping> {
  return authFetch(`/device-catalog/tool-mappings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
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

export function apiRetireDevices(
  imeis: string[],
  reason: string,
): Promise<{ imei: string; outcome: DeviceBatchOutcome }[]> {
  return authFetch("/inventory/retire", {
    method: "POST",
    body: JSON.stringify({ imeis, reason }),
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

// --------------------------------------------------------------------- equipment templates

/**
 * Common onboarding fields for a named/categorised kind of equipment
 * (/equipment-templates, `equipment-template.write` — master admin only).
 * Deliberately separate from EquipmentClass — that is the prediction catalog and
 * stays untouched by this; a template here is onboarding convenience only, not yet
 * wired into the client's own Add Equipment form.
 */
export interface EquipmentTemplate {
  id: string;
  name: string;
  category: string | null;
  manufacturer: string | null;
  engineType: string | null;
  fuelTankCapacityLiters: number | null;
  serviceIntervalHours: number | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EquipmentTemplateInput {
  name?: string;
  category?: string;
  manufacturer?: string;
  engineType?: string;
  fuelTankCapacityLiters?: number;
  serviceIntervalHours?: number;
  description?: string;
}

export function apiListEquipmentTemplates(): Promise<EquipmentTemplate[]> {
  return authFetch("/equipment-templates");
}

export function apiCreateEquipmentTemplate(
  input: EquipmentTemplateInput,
): Promise<EquipmentTemplate> {
  return authFetch("/equipment-templates", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function apiUpdateEquipmentTemplate(
  id: string,
  input: EquipmentTemplateInput,
): Promise<EquipmentTemplate> {
  return authFetch(`/equipment-templates/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
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
  | "parameter_not_set" | "site_boundary_not_set";

export interface KpiSeriesPoint { t: string; v: number | null }

export interface KpiEnvelope {
  formulaKey: string;
  value: number | KpiSeriesPoint[] | null;
  unit: string;
  resultKind: "scalar" | "series";
  window: { from: string; to: string };
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
  | "recommendations" | "machine_list" | "schematic";

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

export type PageWidgetData =
  | PageKpiWidgetData | PageSignalChartData | PageReadinessRow[] | PageAlertRow[] | PageWorkOrderRow[]
  | PageServiceDueData | PageFailureModeRow[] | PageRecommendationRow[] | PageMachineRow[] | PageSchematicData;

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

/** Scores every active scenario on this asset right now, rather than waiting for the
 *  next arrival to trigger it — the one case the route exists for. */
export function apiScorePredictionsNow(sourceSystem: string, externalId: string): Promise<ScoreResult> {
  return authFetch(`/predictions/${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}/score`, {
    method: "POST",
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
