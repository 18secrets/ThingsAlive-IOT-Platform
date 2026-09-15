/** The shapes 2.0 actually returns, named once. */

export type Capability =
  | 'tenant.manage' | 'user.manage' | 'role.manage' | 'tenant.provision'
  | 'equipment.write' | 'scenario.activate' | 'scenario.author' | 'alert.author'
  | 'action.work' | 'action.assign'
  | 'catalog.read' | 'catalog.write' | 'client-catalog.read' | 'client-catalog.write'
  | 'device.manage' | 'device.read' | 'device.claim'
  | 'prediction.read' | 'prediction.run' | 'utilization.read'
  | 'entitlement.grant' | 'platform.admin';

export type Me = {
  tenantId: string;
  userId: string;
  roles: string[];
  isPlatformRole: boolean;
  scope: {
    plants: string[] | 'unrestricted';
    equipment: string[] | 'unrestricted';
    devices: string[] | 'unrestricted';
  };
};

export type Permissions = {
  tenantId: string;
  capabilities: Record<Capability, boolean>;
};

export type TenantStatus = 'active' | 'suspended';

export type Account = {
  tenantId: string;
  name: string;
  status: TenantStatus;
  plan: string | null;
  region: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  provisionedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CatalogStatus = 'draft' | 'published' | 'retired';

export type ExpectedSignal = { signal: string; unit: string | null; required: boolean; description?: string };

export type EquipmentClass = {
  id: string;
  slug: string;
  version: number;
  name: string;
  description: string | null;
  category: string | null;
  expectedSignals: ExpectedSignal[];
  failureModes: { code: string; name: string; symptom: string; signals: string[] }[];
  /** OEM limits. Stripped by the field policy for roles that may not see them. */
  defaultThresholds?: Record<string, unknown>;
  serviceIntervalHours: number | null;
  status: CatalogStatus;
  publishedAt: string | null;
  updatedAt: string;
};

export type Entitlement = {
  id: string;
  tenantId: string;
  equipmentClassSlug: string;
  grantedBy: string;
  grantedAt: string;
  /** A revoked grant keeps its row. Revoked is not deleted, and the copies survive it. */
  revokedAt: string | null;
  revokedBy: string | null;
  note: string | null;
};

export type InventoryState = 'in-stock' | 'assigned' | 'retired';

export type PooledDevice = {
  id: string;
  imei: string;
  state: InventoryState;
  /** Null while a device is in stock — and that null is what hides it from every tenant. */
  tenantId: string | null;
  model: string | null;
  batchRef: string | null;
  receivedAt: string | null;
  assignedAt: string | null;
  assignedBy: string | null;
  /** Set by the customer when they fit it to a machine, not by Things Alive. */
  equipmentExternalId: string | null;
  claimedAt: string | null;
  claimedBy: string | null;
  notes: string | null;
};

export type AssignOutcome =
  | 'assigned' | 'already-in-this-account' | 'held-elsewhere' | 'retired' | 'unknown'
  | 'released' | 'retired-now' | 'returned' | 'not-assigned';

export type BatchResult = { imei: string; outcome: AssignOutcome };

export type PlantStatus = 'active' | 'retired';

export type Plant = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  address: string | null;
  siteArea: string | null;
  capacity: string | null;
  projectType: string | null;
  operationalStatus: string | null;
  description: string | null;
  status: PlantStatus;
  sourceSystem: string | null;
  externalId: string | null;
};

export type ServiceTier = 'basic' | 'standard' | 'advanced' | 'full';

export type Equipment = {
  id: string;
  tenantId: string;
  sourceSystem: string;
  externalId: string;
  equipmentClassSlug: string | null;
  classVersion: number | null;
  tier: ServiceTier;
  commissionedAt: string | null;
  serviceIntervalHours: number | null;
  /** Derived and cached. The recommendation service recomputes it on request. */
  readiness: Record<string, unknown>;
  origin: string;
  status: string;
  name: string | null;
  manufacturer: string | null;
  modelNumber: string | null;
  serialNumber: string | null;
  description: string | null;
  plantId: string | null;
};

export type Placement = {
  id: string;
  plantId: string | null;
  fromPlantId: string | null;
  reason: string | null;
  movedBy: string | null;
  at: string;
};

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type AlertTrigger =
  | 'prediction-severity' | 'signal-threshold' | 'no-telemetry' | 'fuel-loss' | 'chain-origin';

export type ScenarioParameter = {
  key: string; label: string; type: 'number' | 'duration' | 'boolean' | 'enum';
  default: unknown; min?: number; max?: number; options?: string[]; unit?: string;
};

export type Scenario = {
  id: string;
  slug: string;
  version: number;
  equipmentClassSlug: string;
  name: string;
  description: string | null;
  severity: Severity;
  tier: number;
  requiredSignals: string[];
  minimumHistoryDays: number;
  parameters: ScenarioParameter[];
  status: CatalogStatus;
  publishedAt: string | null;
};

export type AlertTemplate = {
  id: string;
  slug: string;
  version: number;
  equipmentClassSlug: string;
  name: string;
  description: string | null;
  trigger: AlertTrigger;
  params: Record<string, unknown>;
  severity: Severity;
  /** Whether the copy arrives switched on, or waiting for somebody to look first. */
  enabledOnCopy: boolean;
  status: CatalogStatus;
  publishedAt: string | null;
};

export type ChainNode = {
  signal: string;
  label?: string;
  intercept: number;
  drivers: { signal: string; coefficient: number }[];
  warnAbove: number;
  criticalAbove: number;
  direction?: 'above' | 'below';
};

export type CausalChain = {
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
  status: CatalogStatus;
  publishedAt: string | null;
};

/**
 * The latest row per slug, which is what an authoring list wants to show.
 *
 * The API returns every version because the authoring screen is the one place that
 * needs them. Collapsing here rather than there keeps the route honest: a screen that
 * wanted the full history could still have it.
 */
export function latestPerSlug<T extends { slug: string; version: number }>(rows: T[]): T[] {
  const newest = new Map<string, T>();
  for (const row of rows) {
    const seen = newest.get(row.slug);
    if (!seen || row.version > seen.version) newest.set(row.slug, row);
  }
  return [...newest.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * A slug has a draft when any of its versions is one. Worth its own function because
 * "is this published" and "is there unpublished work on it" are different questions and
 * both are true at once for most of a class's life.
 */
export function draftOf<T extends { slug: string; status: CatalogStatus }>(
  rows: T[], slug: string,
): T | undefined {
  return rows.find((r) => r.slug === slug && r.status === 'draft');
}

export type DeviceEvent = {
  id: string;
  imei: string;
  action: string;
  fromState: InventoryState | null;
  toState: InventoryState;
  tenantId: string | null;
  equipmentExternalId: string | null;
  reason: string | null;
  actorUserId: string;
  actorRoles: string[];
  at: string;
};

export type Provisioned = {
  tenant: Account;
  roles: string[];
  superAdmin: { id: string; email: string };
  /**
   * Returned once, at creation, and never again — it is the only way the first
   * administrator ever gets in. A screen that shows it and then forgets to make it
   * copyable has lost the account.
   */
  invitationToken: string;
  invitationExpiresAt: string;
  alreadyExisted: boolean;
};
