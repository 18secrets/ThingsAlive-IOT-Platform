export type NavigationTab =
  | 'dashboard'
  | 'ai-onboarding'
  | 'alert-agent'
  | 'admin'
  | 'users'
  | 'settings'
  | 'client-users'
  | 'roles';

// Pages a client's Super Admin can grant to a role. 'client-users' and 'roles'
// are deliberately excluded — those are structural Super Admin capabilities,
// never assignable to a custom role (a role can't grant the ability to manage
// roles). 'users' (Platform Users) and 'administrator' are ThingsAlive-side
// screens and never apply to a client role either.
export const CLIENT_ASSIGNABLE_TABS: NavigationTab[] = ['dashboard', 'ai-onboarding', 'alert-agent', 'admin', 'settings'];

export type UserRole = 'master-admin' | 'client';

// `id` is the account's real tenantId once it comes from the API — there is no
// separate internal id, unlike the mock's `cl-${Date.now()}` scheme. Everything
// below `status` is optional because a real account carries none of it: the API
// has no username, no stored password (a person accepts an invitation instead)
// and no phone at all. Present only for whatever this app still creates locally.
export interface ClientAccount {
  id: string;
  clientName: string;
  contactPersonName?: string;
  phone?: string;
  email?: string;
  username?: string;
  password?: string;
  mustChangePassword?: boolean;
  status: 'Active' | 'Inactive';
  createdAt: string;
}

// A named set of page permissions a client's Super Admin (or Master Admin,
// for support) can assign to that client's users. Every client gets one
// built-in, non-deletable 'Super Admin' role (isSuperAdminRole: true) with
// every assignable page, created automatically alongside the client.
export interface RoleDefinition {
  id: string;
  clientId: string;
  name: string;
  allowedTabs: NavigationTab[];
  isSuperAdminRole?: boolean;
  createdAt: string;
}

// An individual person signed in under a client — replaces the old model
// where a ClientAccount itself was the only login. Every client gets one
// ClientUserItem (its Super Admin) created automatically alongside it.
export interface ClientUserItem {
  id: string;
  clientId: string;
  name: string;
  username: string;
  password: string;
  roleId: string;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

export interface AuthUser {
  role: UserRole;
  username: string;
  clientId?: string;
  clientName?: string;
  /** ClientUserItem.id — set for the 'client' role only. */
  userId?: string;
  /** RoleDefinition.id — set for the 'client' role only. */
  roleId?: string;
  /** Resolved from the user's RoleDefinition at login; drives Sidebar visibility. */
  allowedTabs?: NavigationTab[];
  /** Whether this client user holds the built-in Super Admin role. */
  isSuperAdmin?: boolean;
}

export type PlatformUserRole = 'Operational' | 'Executive' | 'Support' | 'Admin' | 'Super Admin';

export interface PlatformUserItem {
  id: number;
  employeeId: string;
  username: string;
  email: string;
  role: PlatformUserRole;
  phone: string;
  active: boolean;
}

export type AdminSubTab =
  | 'industry'
  | 'sensor'
  | 'category'
  | 'plant'
  | 'tool-mapping'
  | 'devices'
  | 'equipment'
  | 'clients';

export interface SensorParameterSpec {
  parameter: string;
  unit: string;
  min: number;
  max: number;
  normalRange: string;
  notes?: string;
}

export interface SensorItem {
  id: string;
  /** @deprecated Sensors are now grouped by `category` instead. Kept optional for legacy call sites. */
  industryType?: string;
  sensorName: string;
  code?: string;
  createdAt: string;
  updatedAt: string;
  description?: string;
  parameters?: string[];
  protocol?: string;
  /** System category, e.g. Engine, Fuel, Hydraulics, Battery / EV */
  category?: string;
  /** Per-parameter unit/range/notes spec, used by the master sensor reference catalog */
  parameterSpecs?: SensorParameterSpec[];
}

export interface ToolMappingItem {
  id: string;
  identifier: string;
  toolName: string;
  industryType: string;
  mappedSensors: {
    id: string;
    name: string;
    tagColor: 'blue' | 'teal' | 'purple' | 'amber' | 'rose' | 'emerald';
    parameters: string[];
  }[];
  activeParametersCount: number;
  protocol: string;
  updatedAt: string;
}

export interface CategoryItem {
  id: string;
  name: string;
  code: string;
  engineType: string;
  fuelTankCapacityLiters: number;
  description: string;
  createdAt: string;
  active: boolean;
  equipmentCount: number;
}

export interface EquipmentItem {
  id: number;
  name: string;
  description: string;
  category: string;
  maintPlant: string;
  cclNumber: string;
  manufacturer: string;
  modelNumber: string;
  licensePlate: string;
  engine: string;
  status?: 'Active' | 'Under Maintenance' | 'Idle';
  onboardStatus?: 'Onboarded' | 'Pending';
  partNo?: string;
  serialNo?: string;
  fuelCapacity?: number;
  toolMapping?: string;
  assignedSensors?: string[];
  clientName?: string;
  /** ClientAccount.id — the real tenant link; clientName is a display cache of it. */
  clientId?: string;
  deviceId?: number;
}

export interface DeviceItem {
  id: number;
  name: string;
  imei: string;
  equipmentName?: string;
  vendor?: string;
  status: 'Online' | 'Offline';
  toolProfile?: string;
  category?: string;
  plant?: string;
  selectedSensors?: string[];
  mappedSensorsCount?: number;
  lastPing?: string;
  clientName?: string;
  /** ClientAccount.id — the real tenant link; clientName is a display cache of it. */
  clientId?: string;
}

export interface IndustryTypeItem {
  id: string;
  name: string;
  code: string;
  status: 'Active' | 'Inactive';
  createdAt: string;
}

export interface ProtocolItem {
  id: string;
  name: string;
  type: string;
  portDefault: number;
  baudRate?: string;
  devicesCount: number;
  status: 'Active' | 'Inactive';
}

export interface PlantItem {
  id: string;
  name: string;
  location: string;
  code: string;
  equipmentCount: number;
  active: boolean;
  clientName?: string;
  /** ClientAccount.id — the real tenant link; clientName is a display cache of it. */
  clientId?: string;
}

export interface OnboardingSessionItem {
  id: string;
  name: string;
  sitesCount: number;
  equipmentCount: number;
  status: 'Completed' | 'In Progress';
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
