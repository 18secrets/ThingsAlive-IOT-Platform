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
