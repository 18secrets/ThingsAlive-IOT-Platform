/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import {
  SensorItem,
  ToolMappingItem,
  CategoryItem,
  EquipmentItem,
  DeviceItem,
  PlantItem,
  IndustryTypeItem,
  ClientAccount,
  PlatformUserItem,
  ClientUserItem,
  RoleDefinition,
} from './types';
import {
  INITIAL_SENSORS,
  INITIAL_TOOL_MAPPINGS,
  INITIAL_CATEGORIES,
  INITIAL_EQUIPMENT,
  INITIAL_DEVICES,
  INITIAL_INDUSTRY_TYPES,
  INITIAL_PLANTS,
  INITIAL_ONBOARDING_SESSIONS,
  MASTER_ADMIN_CREDENTIALS,
  INITIAL_USERS,
  INITIAL_CLIENT_USERS,
  INITIAL_ROLES,
} from './data/mockData';
import { AuthProvider, useAuth } from './lib/AuthProvider';
import { PageHeaderProvider } from './lib/PageHeaderContext';
import { RequireAuth, GuestOnly } from './routes/guards';
import { Shell } from './shell/Shell';
import { LoginScreen } from './components/auth/LoginScreen';
import { AcceptInvitationScreen } from './components/auth/AcceptInvitationScreen';
import { DashboardPage } from './pages/DashboardPage';
import { AdminPage } from './pages/AdminPage';
import { DeviceSetupPage } from './pages/DeviceSetupPage';
import { AiOnboardingPage } from './pages/AiOnboardingPage';
import { AlertAgentPage } from './pages/AlertAgentPage';
import { UsersPage } from './pages/UsersPage';
import { ClientUsersPage } from './pages/ClientUsersPage';
import { RolesPage } from './pages/RolesPage';
import { SettingsPage } from './pages/SettingsPage';
import {
  apiListAccounts, apiCreateAccount, apiUpdateAccount, apiSuspendAccount, apiReinstateAccount,
  apiResendInvitation, apiListPlants, apiCreatePlant, apiUpdatePlant, apiRetirePlant, apiReopenPlant,
  apiListEquipmentClasses, apiCreateEquipmentClass, apiUpdateEquipmentClass,
  apiPublishEquipmentClass, apiRetireEquipmentClass,
  apiListSensorCategories, apiCreateSensorCategory, apiListSensors, apiCreateSensor, apiUpdateSensor,
  apiListToolMappings, apiCreateToolMapping, apiUpdateToolMapping,
  apiListDevicePool, apiRegisterDevices, apiAssignDevices,
  apiListEquipmentTemplates, apiCreateEquipmentTemplate, apiUpdateEquipmentTemplate,
  apiListRoles, apiCreateRole, apiUpdateRole, apiDeleteRole,
  apiListTenantUsers, apiInviteUser, apiSetUserRole, apiSuspendUser, apiReinstateUser,
  ApiError, Account, ResendInvitationResult, Plant, PlantInput, EquipmentClass, EquipmentClassInput,
  SensorCategory, Sensor, SensorInput, ToolMapping, ToolMappingInput, PooledDevice, RegisterDeviceInput,
  EquipmentTemplate, EquipmentTemplateInput,
  TenantRole, RoleInput, RolePatchInput, TenantUser, InviteUserInput,
} from './lib/api';

const MASTER_ADMIN_PASSWORD_KEY = 'ta_master_admin_password';
const CLIENT_USERS_KEY = 'ta_client_users';
const ROLES_KEY = 'ta_roles';

function loadMasterAdminPassword(): string {
  try {
    return localStorage.getItem(MASTER_ADMIN_PASSWORD_KEY) || MASTER_ADMIN_CREDENTIALS.password;
  } catch {
    return MASTER_ADMIN_CREDENTIALS.password;
  }
}

function loadClientUsers(): ClientUserItem[] {
  try {
    const raw = localStorage.getItem(CLIENT_USERS_KEY);
    return raw ? JSON.parse(raw) : INITIAL_CLIENT_USERS;
  } catch {
    return INITIAL_CLIENT_USERS;
  }
}

function loadRoles(): RoleDefinition[] {
  try {
    const raw = localStorage.getItem(ROLES_KEY);
    return raw ? JSON.parse(raw) : INITIAL_ROLES;
  } catch {
    return INITIAL_ROLES;
  }
}

// A real account, as the existing ClientAccount-shaped UI displays it.
// Contact info is the account's ceo-manager, not a separate "contact person" —
// the API has no such concept, only the super admin it actually created. There
// is still no username or password: a real login is by email, and the client
// sets their own password by accepting the invitation, never handed one here.
function accountToClient(a: Account): ClientAccount {
  return {
    id: a.tenantId,
    clientName: a.name,
    contactPersonName: a.superAdmin?.fullName,
    phone: a.superAdmin?.phone ?? undefined,
    email: a.superAdmin?.email,
    // 'invited' is the real first-login signal (app_user.status) — the super
    // admin exists but has never accepted their invitation, so no password
    // has ever been set. This is what the card's badge reads.
    mustChangePassword: a.superAdmin?.status === 'invited',
    status: a.status === 'active' ? 'Active' : 'Inactive',
    createdAt: new Date(a.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
  };
}

/** `/admin` on its own picks a sensible default subtab for whoever is signed in. */
function AdminIndexRedirect() {
  const { authUser } = useAuth();
  // 'industry' is hidden from Master Admin's tab bar for now, so their default
  // landing tab is 'clients' instead.
  const subTab = authUser?.role === 'client' ? 'plant' : 'clients';
  return <Navigate to={`/admin/${subTab}`} replace />;
}

function AppData() {
  const { authUser, restoringSession } = useAuth();
  const navigate = useNavigate();

  // Real accounts (Clients admin screen) — fetched from the API, never
  // cached locally. Everything below this is still mock data.
  const [clients, setClients] = useState<ClientAccount[]>([]);
  const [accountsError, setAccountsError] = useState<string | undefined>(undefined);
  // The signed-in client's own real sites (GET /equipment/plants). Separate
  // from the mock `plants` array below on purpose: Master Admin has no
  // tenant of their own, so this stays empty for them, while their still-mock
  // Equipment/Devices screens keep working off INITIAL_PLANTS unaffected.
  const [realPlants, setRealPlants] = useState<Plant[]>([]);
  const [plantsError, setPlantsError] = useState<string | undefined>(undefined);
  // The real catalog (Equipment Classes admin screen) — platform-owned, so
  // this is Master Admin's data the same way accounts are, not tenant data
  // the way plants are. Separate from the mock `categories` array below,
  // which still feeds Equipment's still-mock "category" picker.
  const [equipmentClasses, setEquipmentClasses] = useState<EquipmentClass[]>([]);
  const [equipmentClassesError, setEquipmentClassesError] = useState<string | undefined>(undefined);
  // Master Admin's real reference data for wiring a device before it exists —
  // separate from the mock `sensors`/`toolMappings`/`devices` below, which
  // still feed Equipment's still-mock pickers and the client's still-mock
  // Devices tab.
  const [sensorCategories, setSensorCategories] = useState<SensorCategory[]>([]);
  const [realSensors, setRealSensors] = useState<Sensor[]>([]);
  const [sensorsError, setSensorsError] = useState<string | undefined>(undefined);
  const [realToolMappings, setRealToolMappings] = useState<ToolMapping[]>([]);
  const [toolMappingsError, setToolMappingsError] = useState<string | undefined>(undefined);
  const [devicePool, setDevicePool] = useState<PooledDevice[]>([]);
  const [devicePoolError, setDevicePoolError] = useState<string | undefined>(undefined);
  // Onboarding-convenience templates — separate from `equipmentClasses` above,
  // which is the prediction catalog and stays untouched by this.
  const [equipmentTemplates, setEquipmentTemplates] = useState<EquipmentTemplate[]>([]);
  const [equipmentTemplatesError, setEquipmentTemplatesError] = useState<string | undefined>(undefined);
  // The signed-in client's own real roles/users (/identity/roles, /identity/users)
  // — separate from the mock `roles`/`clientUsers` below, which still feed the
  // Master-Admin-only cross-client view (AllClientUsersView), out of scope this
  // round: there is no real cross-tenant read for another account's people.
  const [tenantRoles, setTenantRoles] = useState<TenantRole[]>([]);
  const [rolesError, setRolesError] = useState<string | undefined>(undefined);
  const [tenantUsers, setTenantUsers] = useState<TenantUser[]>([]);
  const [usersError, setUsersError] = useState<string | undefined>(undefined);
  const [clientUsers, setClientUsers] = useState<ClientUserItem[]>(loadClientUsers);
  const [roles, setRoles] = useState<RoleDefinition[]>(loadRoles);
  const [masterAdminPassword, setMasterAdminPassword] = useState<string>(loadMasterAdminPassword);
  // Master Admin's optional drill-down into one client's Users/Roles screens.
  const [manageAccessClientId, setManageAccessClientId] = useState<string | null>(null);

  const [sensors, setSensors] = useState<SensorItem[]>(INITIAL_SENSORS);
  const [toolMappings, setToolMappings] = useState<ToolMappingItem[]>(INITIAL_TOOL_MAPPINGS);
  const [categories, setCategories] = useState<CategoryItem[]>(INITIAL_CATEGORIES);
  const [equipmentList, setEquipmentList] = useState<EquipmentItem[]>(INITIAL_EQUIPMENT);
  const [devices, setDevices] = useState<DeviceItem[]>(INITIAL_DEVICES);
  const [industryTypes, setIndustryTypes] = useState<IndustryTypeItem[]>(INITIAL_INDUSTRY_TYPES);
  const [plants, setPlants] = useState<PlantItem[]>(INITIAL_PLANTS);
  const [onboardingSessions, setOnboardingSessions] = useState(INITIAL_ONBOARDING_SESSIONS);
  const [users, setUsers] = useState<PlatformUserItem[]>(INITIAL_USERS);

  const refreshAccounts = async () => {
    try {
      const accounts = await apiListAccounts();
      setClients(accounts.map(accountToClient));
      setAccountsError(undefined);
    } catch (err) {
      setAccountsError(err instanceof ApiError ? err.message : 'Could not load accounts.');
    }
  };

  useEffect(() => {
    // Wait for the session-resume check: `authUser` can be a cached, optimistic
    // value from sessionStorage before the real access token is confirmed to
    // still work, and firing early sends an authenticated call with no token
    // at all — surfaced to the user as a raw "Bearer token required." error.
    if (restoringSession || authUser?.role !== 'master-admin') return;
    let live = true;
    (async () => {
      try {
        const accounts = await apiListAccounts();
        if (!live) return;
        setClients(accounts.map(accountToClient));
        setAccountsError(undefined);
      } catch (err) {
        if (live) setAccountsError(err instanceof ApiError ? err.message : 'Could not load accounts.');
      }
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);

  const refreshPlants = async () => {
    try {
      setRealPlants(await apiListPlants());
      setPlantsError(undefined);
    } catch (err) {
      setPlantsError(err instanceof ApiError ? err.message : 'Could not load plants.');
    }
  };

  useEffect(() => {
    if (restoringSession || authUser?.role !== 'client') return;
    let live = true;
    (async () => {
      try {
        const list = await apiListPlants();
        if (!live) return;
        setRealPlants(list);
        setPlantsError(undefined);
      } catch (err) {
        if (live) setPlantsError(err instanceof ApiError ? err.message : 'Could not load plants.');
      }
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);

  const refreshRoles = async () => {
    try {
      setTenantRoles(await apiListRoles());
      setRolesError(undefined);
    } catch (err) {
      setRolesError(err instanceof ApiError ? err.message : 'Could not load roles.');
    }
  };

  const refreshTenantUsers = async () => {
    try {
      setTenantUsers(await apiListTenantUsers());
      setUsersError(undefined);
    } catch (err) {
      setUsersError(err instanceof ApiError ? err.message : 'Could not load users.');
    }
  };

  useEffect(() => {
    if (restoringSession || authUser?.role !== 'client') return;
    let live = true;
    (async () => {
      try {
        const list = await apiListRoles();
        if (live) { setTenantRoles(list); setRolesError(undefined); }
      } catch (err) {
        if (live) setRolesError(err instanceof ApiError ? err.message : 'Could not load roles.');
      }
      try {
        const list = await apiListTenantUsers();
        if (live) { setTenantUsers(list); setUsersError(undefined); }
      } catch (err) {
        if (live) setUsersError(err instanceof ApiError ? err.message : 'Could not load users.');
      }
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);

  const refreshEquipmentClasses = async () => {
    try {
      setEquipmentClasses(await apiListEquipmentClasses());
      setEquipmentClassesError(undefined);
    } catch (err) {
      setEquipmentClassesError(err instanceof ApiError ? err.message : 'Could not load equipment classes.');
    }
  };

  useEffect(() => {
    // Wait for the session-resume check: `authUser` can be a cached, optimistic
    // value from sessionStorage before the real access token is confirmed to
    // still work, and firing early sends an authenticated call with no token
    // at all — surfaced to the user as a raw "Bearer token required." error.
    if (restoringSession || authUser?.role !== 'master-admin') return;
    let live = true;
    (async () => {
      try {
        const list = await apiListEquipmentClasses();
        if (!live) return;
        setEquipmentClasses(list);
        setEquipmentClassesError(undefined);
      } catch (err) {
        if (live) setEquipmentClassesError(err instanceof ApiError ? err.message : 'Could not load equipment classes.');
      }
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);

  const refreshSensorCatalog = async () => {
    try {
      const [cats, list] = await Promise.all([apiListSensorCategories(), apiListSensors()]);
      setSensorCategories(cats);
      setRealSensors(list);
      setSensorsError(undefined);
    } catch (err) {
      setSensorsError(err instanceof ApiError ? err.message : 'Could not load sensors.');
    }
  };

  const refreshToolMappings = async () => {
    try {
      setRealToolMappings(await apiListToolMappings());
      setToolMappingsError(undefined);
    } catch (err) {
      setToolMappingsError(err instanceof ApiError ? err.message : 'Could not load tool mappings.');
    }
  };

  const refreshDevicePool = async () => {
    try {
      setDevicePool(await apiListDevicePool());
      setDevicePoolError(undefined);
    } catch (err) {
      setDevicePoolError(err instanceof ApiError ? err.message : 'Could not load the device pool.');
    }
  };

  const refreshEquipmentTemplates = async () => {
    try {
      setEquipmentTemplates(await apiListEquipmentTemplates());
      setEquipmentTemplatesError(undefined);
    } catch (err) {
      setEquipmentTemplatesError(err instanceof ApiError ? err.message : 'Could not load equipment templates.');
    }
  };

  useEffect(() => {
    // Wait for the session-resume check: `authUser` can be a cached, optimistic
    // value from sessionStorage before the real access token is confirmed to
    // still work, and firing early sends an authenticated call with no token
    // at all — surfaced to the user as a raw "Bearer token required." error.
    if (restoringSession || authUser?.role !== 'master-admin') return;
    let live = true;
    (async () => {
      const [cats, list] = await Promise.all([apiListSensorCategories(), apiListSensors()])
        .catch((err) => {
          if (live) setSensorsError(err instanceof ApiError ? err.message : 'Could not load sensors.');
          return [null, null] as const;
        });
      if (live && cats && list) { setSensorCategories(cats); setRealSensors(list); setSensorsError(undefined); }

      try {
        const mappings = await apiListToolMappings();
        if (live) { setRealToolMappings(mappings); setToolMappingsError(undefined); }
      } catch (err) {
        if (live) setToolMappingsError(err instanceof ApiError ? err.message : 'Could not load tool mappings.');
      }

      try {
        const pool = await apiListDevicePool();
        if (live) { setDevicePool(pool); setDevicePoolError(undefined); }
      } catch (err) {
        if (live) setDevicePoolError(err instanceof ApiError ? err.message : 'Could not load the device pool.');
      }

      try {
        const templates = await apiListEquipmentTemplates();
        if (live) { setEquipmentTemplates(templates); setEquipmentTemplatesError(undefined); }
      } catch (err) {
        if (live) setEquipmentTemplatesError(err instanceof ApiError ? err.message : 'Could not load equipment templates.');
      }
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);

  useEffect(() => {
    localStorage.setItem(MASTER_ADMIN_PASSWORD_KEY, masterAdminPassword);
  }, [masterAdminPassword]);

  useEffect(() => {
    localStorage.setItem(CLIENT_USERS_KEY, JSON.stringify(clientUsers));
  }, [clientUsers]);

  useEffect(() => {
    localStorage.setItem(ROLES_KEY, JSON.stringify(roles));
  }, [roles]);

  // Self-service password change from Settings, for either role. Returns an
  // error message on failure, or null on success.
  const handleChangeOwnPassword = (currentPassword: string, newPassword: string): string | null => {
    if (!authUser) return 'You must be signed in to change your password.';

    if (authUser.role === 'master-admin') {
      if (currentPassword !== masterAdminPassword) {
        return 'Current password is incorrect.';
      }
      setMasterAdminPassword(newPassword);
      return null;
    }

    const user = clientUsers.find((u) => u.id === authUser.userId);
    if (!user) {
      return 'Account not found.';
    }
    if (currentPassword !== user.password) {
      return 'Current password is incorrect.';
    }
    setClientUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, password: newPassword } : u)));
    return null;
  };

  // POST /accounts, for real — creates the tenant and its super admin in one
  // transaction and returns an invitation token. There is no password to
  // invent here: the modal shows that token so it can be handed to the
  // client, who sets their own via POST /auth/accept-invitation.
  const handleCreateAccount = async (
    input: { tenantId: string; name: string; email: string; fullName: string; phone?: string },
  ) => {
    const result = await apiCreateAccount({
      tenantId: input.tenantId,
      name: input.name,
      superAdmin: { email: input.email, fullName: input.fullName, phone: input.phone },
    });
    // Re-read from the server rather than trust the create response to be
    // the whole picture — the same reason the edit and suspend/reinstate
    // handlers below do it too.
    await refreshAccounts();
    return result;
  };

  // PATCH /accounts/:id — renames the account and/or corrects its super
  // admin's own contact details. Cannot move the tenantId or hand the role to
  // a different person; see ProvisioningService.update's own comment on why.
  const handleUpdateAccount = async (
    tenantId: string,
    input: { name: string; email: string; fullName: string; phone?: string },
  ) => {
    const updated = await apiUpdateAccount(tenantId, {
      name: input.name,
      superAdmin: { email: input.email, fullName: input.fullName, phone: input.phone },
    });
    await refreshAccounts();
    return updated;
  };

  // Suspend/reinstate are real too (POST /accounts/:id/suspend|reinstate).
  // Suspending needs a reason — the API requires one and audits it — so a
  // browser prompt stands in for a proper dialog until this screen gets one.
  const handleToggleClientStatus = async (id: string) => {
    const current = clients.find((c) => c.id === id);
    if (!current) return;
    try {
      if (current.status === 'Active') {
        const reason = window.prompt(`Why is ${current.clientName} being suspended?`);
        if (!reason) return;
        await apiSuspendAccount(id, reason);
      } else {
        await apiReinstateAccount(id);
      }
      await refreshAccounts();
    } catch (err) {
      setAccountsError(err instanceof ApiError ? err.message : 'That action failed.');
    }
  };

  // Only works while the super admin has never accepted the first one — see
  // ProvisioningService.resendInvitation. This is a fresh token, not the
  // original one; the old one stops working the moment this succeeds.
  const handleResendInvitation = (tenantId: string): Promise<ResendInvitationResult> =>
    apiResendInvitation(tenantId);

  // POST /identity/users, for real — invites a person into the signed-in client's
  // own account. The invitation token is shown once, same pattern as a new
  // account's first super admin (handleCreateAccount above).
  const handleInviteUser = async (input: InviteUserInput) => {
    const result = await apiInviteUser(input);
    await refreshTenantUsers();
    return result;
  };

  const handleSetUserRole = async (userId: string, roleSlug: string) => {
    const updated = await apiSetUserRole(userId, roleSlug);
    await refreshTenantUsers();
    return updated;
  };

  const handleSuspendUser = async (userId: string, reason: string) => {
    const updated = await apiSuspendUser(userId, reason);
    await refreshTenantUsers();
    return updated;
  };

  const handleReinstateUser = async (userId: string) => {
    const updated = await apiReinstateUser(userId);
    await refreshTenantUsers();
    return updated;
  };

  const backToClients = () => {
    setManageAccessClientId(null);
    navigate('/admin/clients');
  };

  const manageClientAccess = (clientId: string) => {
    setManageAccessClientId(clientId);
    navigate('/client-users');
  };

  // POST /identity/roles, for real — composed from an existing role's own
  // capabilities/scopeShape (see RoleManagement's "Based on" picker); this form
  // only ever edits name and page access directly.
  const handleCreateRole = async (input: RoleInput) => {
    const created = await apiCreateRole(input);
    await refreshRoles();
    return created;
  };

  const handleUpdateRole = async (slug: string, input: RolePatchInput) => {
    const updated = await apiUpdateRole(slug, input);
    await refreshRoles();
    return updated;
  };

  const handleDeleteRole = async (slug: string) => {
    await apiDeleteRole(slug);
    await refreshRoles();
  };

  const handleAddUser = (newUser: PlatformUserItem) => setUsers((prev) => [newUser, ...prev]);
  const handleUpdateUser = (updatedUser: PlatformUserItem) => setUsers((prev) => prev.map((u) => (u.id === updatedUser.id ? updatedUser : u)));
  const handleDeleteUser = (id: number) => setUsers((prev) => prev.filter((u) => u.id !== id));
  const handleToggleUserStatus = (id: number) => setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, active: !u.active } : u)));

  // POST /device-catalog/sensors and friends, for real — Master Admin's own
  // reference data for wiring a device before it exists.
  const handleCreateSensorCategory = async (name: string) => {
    const created = await apiCreateSensorCategory(name);
    await refreshSensorCatalog();
    return created;
  };
  const handleCreateSensor = async (input: SensorInput) => {
    const created = await apiCreateSensor(input);
    await refreshSensorCatalog();
    return created;
  };
  const handleUpdateSensor = async (id: string, input: SensorInput) => {
    const updated = await apiUpdateSensor(id, input);
    await refreshSensorCatalog();
    return updated;
  };
  const handleCreateToolMapping = async (input: ToolMappingInput) => {
    const created = await apiCreateToolMapping(input);
    await refreshToolMappings();
    return created;
  };
  const handleUpdateToolMapping = async (id: string, input: ToolMappingInput) => {
    const updated = await apiUpdateToolMapping(id, input);
    await refreshToolMappings();
    return updated;
  };
  const handleRegisterDevices = async (devicesToRegister: RegisterDeviceInput[]) => {
    const result = await apiRegisterDevices(devicesToRegister);
    await refreshDevicePool();
    return result;
  };
  const handleAssignDevice = async (imei: string, tenantId: string) => {
    await apiAssignDevices([imei], tenantId);
    await refreshDevicePool();
  };
  // POST /catalog/equipment-classes, for real — Master Admin authors the
  // template as a draft; publishing it (a separate step) is what makes it
  // visible to any tenant's entitlement join.
  const handleCreateEquipmentClass = async (slug: string, input: EquipmentClassInput) => {
    const created = await apiCreateEquipmentClass(slug, input);
    await refreshEquipmentClasses();
    return created;
  };

  const handleUpdateEquipmentClass = async (slug: string, input: EquipmentClassInput) => {
    const updated = await apiUpdateEquipmentClass(slug, input);
    await refreshEquipmentClasses();
    return updated;
  };

  const handlePublishEquipmentClass = async (slug: string) => {
    try {
      await apiPublishEquipmentClass(slug);
      await refreshEquipmentClasses();
    } catch (err) {
      setEquipmentClassesError(err instanceof ApiError ? err.message : 'Could not publish.');
    }
  };

  const handleRetireEquipmentClass = async (slug: string) => {
    try {
      await apiRetireEquipmentClass(slug);
      await refreshEquipmentClasses();
    } catch (err) {
      setEquipmentClassesError(err instanceof ApiError ? err.message : 'Could not retire.');
    }
  };
  const handleCreateEquipmentTemplate = async (input: EquipmentTemplateInput) => {
    const created = await apiCreateEquipmentTemplate(input);
    await refreshEquipmentTemplates();
    return created;
  };
  const handleUpdateEquipmentTemplate = async (id: string, input: EquipmentTemplateInput) => {
    const updated = await apiUpdateEquipmentTemplate(id, input);
    await refreshEquipmentTemplates();
    return updated;
  };
  const handleAddEquipment = (newEquip: EquipmentItem) => setEquipmentList([newEquip, ...equipmentList]);
  // POST /equipment/plants, for real. Runs inside the caller's own tenant
  // session — there is no client picker, unlike the mock version this
  // replaced, because the plant already belongs to whoever is asking.
  const handleCreatePlant = async (input: PlantInput) => {
    const created = await apiCreatePlant(input);
    await refreshPlants();
    return created;
  };

  const handleUpdatePlantReal = async (id: string, input: Partial<PlantInput>) => {
    const updated = await apiUpdatePlant(id, input);
    await refreshPlants();
    return updated;
  };

  // Retire/reopen — retiring is refused by the API (409) while equipment is
  // still standing there, so the error has to reach the screen, not just be
  // swallowed the way a plain toggle would.
  const handleTogglePlantStatus = async (id: string, currentStatus: Plant['status']) => {
    try {
      if (currentStatus === 'active') await apiRetirePlant(id); else await apiReopenPlant(id);
      await refreshPlants();
    } catch (err) {
      setPlantsError(err instanceof ApiError ? err.message : 'That action failed.');
    }
  };
  const handleAddIndustryType = (newType: IndustryTypeItem) => setIndustryTypes([newType, ...industryTypes]);
  const handleUpdateIndustryType = (updatedType: IndustryTypeItem) =>
    setIndustryTypes(industryTypes.map((i) => (i.id === updatedType.id ? updatedType : i)));
  const handleDeleteIndustryType = (id: string) => setIndustryTypes(industryTypes.filter((i) => i.id !== id));
  const handleAddDevice = (newDevice: DeviceItem) => setDevices([newDevice, ...devices]);
  const handleDeleteDevice = (id: number) => setDevices(devices.filter((d) => d.id !== id));
  const handleToggleOnboardingActive = (id: string) =>
    setOnboardingSessions(onboardingSessions.map((s) => (s.id === id ? { ...s, active: !s.active } : s)));
  const handleRefreshOnboardingSession = (id: string) =>
    setOnboardingSessions(onboardingSessions.map((s) => (s.id === id ? { ...s, updatedAt: 'Just now' } : s)));

  return (
    <Routes>
      <Route element={<GuestOnly />}>
        <Route path="/sign-in" element={<LoginScreen />} />
        <Route path="/accept-invitation" element={<AcceptInvitationScreen />} />
      </Route>

      <Route element={<RequireAuth />}>
        <Route element={<Shell onSidebarNavigate={() => setManageAccessClientId(null)} />}>
          <Route index element={<Navigate to="/dashboard" replace />} />

          <Route
            path="dashboard"
            element={
              <DashboardPage
                clients={clients}
                devices={devices}
                equipmentList={equipmentList}
                onboardingSessions={onboardingSessions}
              />
            }
          />

          <Route path="admin">
            <Route index element={<AdminIndexRedirect />} />
            <Route
              path="devices/new"
              element={
                <DeviceSetupPage
                  toolMappings={toolMappings}
                  sensors={sensors}
                  categories={categories}
                  plants={plants}
                  clients={clients}
                  onSaveDevice={handleAddDevice}
                  realToolMappings={realToolMappings}
                  onRegisterDevices={handleRegisterDevices}
                />
              }
            />
            <Route
              path=":subTab"
              element={
                <AdminPage
                  sensors={sensors}
                  toolMappings={toolMappings}
                  categories={categories}
                  industryTypes={industryTypes}
                  plants={plants}
                  sensorCategories={sensorCategories}
                  realSensors={realSensors}
                  sensorsError={sensorsError}
                  onCreateSensor={handleCreateSensor}
                  onUpdateSensor={handleUpdateSensor}
                  onCreateSensorCategory={handleCreateSensorCategory}
                  realToolMappings={realToolMappings}
                  toolMappingsError={toolMappingsError}
                  onCreateToolMapping={handleCreateToolMapping}
                  onUpdateToolMapping={handleUpdateToolMapping}
                  devicePool={devicePool}
                  devicePoolError={devicePoolError}
                  onNavigateToRegisterDevice={() => navigate('/admin/devices/new')}
                  onAssignDevice={handleAssignDevice}
                  equipmentClasses={equipmentClasses}
                  equipmentClassesError={equipmentClassesError}
                  onCreateEquipmentClass={handleCreateEquipmentClass}
                  onUpdateEquipmentClass={handleUpdateEquipmentClass}
                  onPublishEquipmentClass={handlePublishEquipmentClass}
                  onRetireEquipmentClass={handleRetireEquipmentClass}
                  equipmentTemplates={equipmentTemplates}
                  equipmentTemplatesError={equipmentTemplatesError}
                  onCreateEquipmentTemplate={handleCreateEquipmentTemplate}
                  onUpdateEquipmentTemplate={handleUpdateEquipmentTemplate}
                  onAddIndustryType={handleAddIndustryType}
                  onUpdateIndustryType={handleUpdateIndustryType}
                  onDeleteIndustryType={handleDeleteIndustryType}
                  realPlants={realPlants}
                  plantsError={plantsError}
                  onCreatePlant={handleCreatePlant}
                  onUpdatePlant={handleUpdatePlantReal}
                  onTogglePlantStatus={handleTogglePlantStatus}
                  devices={devices}
                  onDeleteDevice={handleDeleteDevice}
                  equipmentList={equipmentList}
                  onAddEquipment={handleAddEquipment}
                  clients={clients}
                  accountsError={accountsError}
                  onCreateAccount={handleCreateAccount}
                  onUpdateAccount={handleUpdateAccount}
                  onResendInvitation={handleResendInvitation}
                  onToggleClientStatus={handleToggleClientStatus}
                />
              }
            />
          </Route>

          <Route
            path="ai-onboarding"
            element={
              <AiOnboardingPage
                sessions={onboardingSessions}
                onToggleActive={handleToggleOnboardingActive}
                onRefreshSession={handleRefreshOnboardingSession}
              />
            }
          />

          <Route path="alert-agent" element={<AlertAgentPage />} />

          <Route
            path="users"
            element={
              <UsersPage
                users={users}
                onAddUser={handleAddUser}
                onUpdateUser={handleUpdateUser}
                onDeleteUser={handleDeleteUser}
                onToggleUserStatus={handleToggleUserStatus}
                clients={clients}
                clientUsers={clientUsers}
                roles={roles}
                onManageClientAccess={manageClientAccess}
              />
            }
          />

          <Route
            path="client-users"
            element={
              <ClientUsersPage
                users={tenantUsers}
                roles={tenantRoles}
                error={usersError}
                manageAccessClientId={manageAccessClientId}
                onBackToClients={backToClients}
                onInviteUser={handleInviteUser}
                onSetUserRole={handleSetUserRole}
                onSuspendUser={handleSuspendUser}
                onReinstateUser={handleReinstateUser}
              />
            }
          />

          <Route
            path="roles"
            element={
              <RolesPage
                roles={tenantRoles}
                users={tenantUsers}
                error={rolesError}
                manageAccessClientId={manageAccessClientId}
                onBackToClients={backToClients}
                onCreateRole={handleCreateRole}
                onUpdateRole={handleUpdateRole}
                onDeleteRole={handleDeleteRole}
              />
            }
          />

          <Route
            path="settings"
            element={<SettingsPage clients={clients} onChangePassword={handleChangeOwnPassword} />}
          />

          {/* Catches every signed-in path that isn't one of the routes above.
              An unauthenticated visit never reaches this far — RequireAuth
              redirects to /sign-in before Shell (and this route) render. */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <PageHeaderProvider>
          <AppData />
        </PageHeaderProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
