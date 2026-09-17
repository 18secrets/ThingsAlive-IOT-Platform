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
  status: 'active' | 'retired';
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
  return authFetch(`/equipment/plants${includeRetired ? '?includeRetired=true' : ''}`);
}

export function apiCreatePlant(input: PlantInput): Promise<Plant> {
  return authFetch('/equipment/plants', { method: 'POST', body: JSON.stringify(input) });
}

export function apiUpdatePlant(id: string, input: Partial<PlantInput>): Promise<Plant> {
  return authFetch(`/equipment/plants/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function apiRetirePlant(id: string): Promise<Plant> {
  return authFetch(`/equipment/plants/${encodeURIComponent(id)}/retire`, { method: 'POST' });
}

export function apiReopenPlant(id: string): Promise<Plant> {
  return authFetch(`/equipment/plants/${encodeURIComponent(id)}/reopen`, { method: 'POST' });
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
  status: 'draft' | 'published' | 'retired';
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
  return authFetch('/catalog/authoring/equipment-classes');
}

export function apiCreateEquipmentClass(slug: string, input: EquipmentClassInput): Promise<EquipmentClass> {
  return authFetch('/catalog/equipment-classes', { method: 'POST', body: JSON.stringify({ slug, ...input }) });
}

/** Edits the working draft, forking one from the published version if none exists yet. */
export function apiUpdateEquipmentClass(slug: string, input: EquipmentClassInput): Promise<EquipmentClass> {
  return authFetch(`/catalog/equipment-classes/${encodeURIComponent(slug)}`, {
    method: 'PATCH', body: JSON.stringify(input),
  });
}

/** Refused with no expected signals — a class declaring none blocks every scenario on it. */
export function apiPublishEquipmentClass(slug: string): Promise<EquipmentClass> {
  return authFetch(`/catalog/equipment-classes/${encodeURIComponent(slug)}/publish`, { method: 'POST' });
}

/** Stops offering it; accounts that already have a copy keep running it. */
export function apiRetireEquipmentClass(slug: string): Promise<EquipmentClass[]> {
  return authFetch(`/catalog/equipment-classes/${encodeURIComponent(slug)}/retire`, { method: 'POST' });
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
  return authFetch('/device-catalog/categories');
}

export function apiCreateSensorCategory(name: string): Promise<SensorCategory> {
  return authFetch('/device-catalog/categories', { method: 'POST', body: JSON.stringify({ name }) });
}

export function apiListSensors(): Promise<Sensor[]> {
  return authFetch('/device-catalog/sensors');
}

export function apiCreateSensor(input: SensorInput): Promise<Sensor> {
  return authFetch('/device-catalog/sensors', { method: 'POST', body: JSON.stringify(input) });
}

export function apiUpdateSensor(id: string, input: SensorInput): Promise<Sensor> {
  return authFetch(`/device-catalog/sensors/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(input),
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
  return authFetch('/device-catalog/tool-mappings');
}

export function apiCreateToolMapping(input: ToolMappingInput): Promise<ToolMapping> {
  return authFetch('/device-catalog/tool-mappings', { method: 'POST', body: JSON.stringify(input) });
}

export function apiUpdateToolMapping(id: string, input: ToolMappingInput): Promise<ToolMapping> {
  return authFetch(`/device-catalog/tool-mappings/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(input),
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
  state: 'in-stock' | 'assigned' | 'retired';
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
  filters: { state?: PooledDevice['state']; tenantId?: string; unassignedOnly?: boolean } = {},
): Promise<PooledDevice[]> {
  const params = new URLSearchParams();
  if (filters.state) params.set('state', filters.state);
  if (filters.tenantId) params.set('tenantId', filters.tenantId);
  if (filters.unassignedOnly) params.set('unassignedOnly', 'true');
  const query = params.toString();
  return authFetch(`/inventory/pool${query ? `?${query}` : ''}`);
}

export function apiRegisterDevices(devices: RegisterDeviceInput[]): Promise<{ registered: number; alreadyKnown: number }> {
  return authFetch('/inventory/register', { method: 'POST', body: JSON.stringify({ devices }) });
}

export type DeviceBatchOutcome = 'assigned' | 'already-in-this-account' | 'held-elsewhere' | 'retired' | 'unknown';

export function apiAssignDevices(
  imeis: string[], tenantId: string,
): Promise<{ imei: string; outcome: DeviceBatchOutcome }[]> {
  return authFetch('/inventory/assign', { method: 'POST', body: JSON.stringify({ imeis, tenantId }) });
}

export function apiReleaseDevices(imeis: string[], reason: string): Promise<{ imei: string; outcome: DeviceBatchOutcome }[]> {
  return authFetch('/inventory/release', { method: 'POST', body: JSON.stringify({ imeis, reason }) });
}

export function apiRetireDevices(imeis: string[], reason: string): Promise<{ imei: string; outcome: DeviceBatchOutcome }[]> {
  return authFetch('/inventory/retire', { method: 'POST', body: JSON.stringify({ imeis, reason }) });
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
  return authFetch('/equipment-templates');
}

export function apiCreateEquipmentTemplate(input: EquipmentTemplateInput): Promise<EquipmentTemplate> {
  return authFetch('/equipment-templates', { method: 'POST', body: JSON.stringify(input) });
}

export function apiUpdateEquipmentTemplate(id: string, input: EquipmentTemplateInput): Promise<EquipmentTemplate> {
  return authFetch(`/equipment-templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}
