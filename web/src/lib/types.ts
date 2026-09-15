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
