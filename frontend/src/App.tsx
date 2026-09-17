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
  apiResendInvitation, ApiError, Account, ResendInvitationResult,
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
  const subTab = authUser?.role === 'client' ? 'plant' : 'industry';
  return <Navigate to={`/admin/${subTab}`} replace />;
}

function AppData() {
  const { authUser } = useAuth();
  const navigate = useNavigate();

  // Real accounts (Clients admin screen) — fetched from the API, never
  // cached locally. Everything below this is still mock data.
  const [clients, setClients] = useState<ClientAccount[]>([]);
  const [accountsError, setAccountsError] = useState<string | undefined>(undefined);
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
    if (authUser?.role !== 'master-admin') return;
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
  }, [authUser]);

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

  const handleAddClientUser = (user: ClientUserItem) => setClientUsers((prev) => [user, ...prev]);
  const handleUpdateClientUser = (user: ClientUserItem) => setClientUsers((prev) => prev.map((u) => (u.id === user.id ? user : u)));
  const handleDeleteClientUser = (id: string) => setClientUsers((prev) => prev.filter((u) => u.id !== id));
  const handleToggleClientUserStatus = (id: string) => setClientUsers((prev) => prev.map((u) => (u.id === id ? { ...u, active: !u.active } : u)));
  const handleResetClientUserPassword = (id: string) => setClientUsers((prev) => prev.map((u) => (u.id === id ? { ...u, mustChangePassword: true } : u)));

  const backToClients = () => {
    setManageAccessClientId(null);
    navigate('/admin/clients');
  };

  const manageClientAccess = (clientId: string) => {
    setManageAccessClientId(clientId);
    navigate('/client-users');
  };

  const handleAddRole = (role: RoleDefinition) => setRoles((prev) => [role, ...prev]);
  const handleUpdateRole = (role: RoleDefinition) => setRoles((prev) => prev.map((r) => (r.id === role.id ? role : r)));
  const handleDeleteRole = (id: string) => setRoles((prev) => prev.filter((r) => r.id !== id));

  const handleAddUser = (newUser: PlatformUserItem) => setUsers((prev) => [newUser, ...prev]);
  const handleUpdateUser = (updatedUser: PlatformUserItem) => setUsers((prev) => prev.map((u) => (u.id === updatedUser.id ? updatedUser : u)));
  const handleDeleteUser = (id: number) => setUsers((prev) => prev.filter((u) => u.id !== id));
  const handleToggleUserStatus = (id: number) => setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, active: !u.active } : u)));

  const handleAddSensor = (newSensor: SensorItem) => setSensors([newSensor, ...sensors]);
  const handleAddToolMapping = (newMapping: ToolMappingItem) =>
    setToolMappings([newMapping, ...toolMappings.filter((t) => t.id !== newMapping.id)]);
  const handleAddCategory = (newCat: CategoryItem) => setCategories([newCat, ...categories]);
  const handleUpdateCategory = (updatedCat: CategoryItem) =>
    setCategories(categories.map((c) => (c.id === updatedCat.id ? updatedCat : c)));
  const handleDeleteCategory = (id: string) => setCategories(categories.filter((c) => c.id !== id));
  const handleAddEquipment = (newEquip: EquipmentItem) => setEquipmentList([newEquip, ...equipmentList]);
  const handleAddPlant = (newPlant: PlantItem) => setPlants([newPlant, ...plants]);
  const handleUpdatePlant = (updatedPlant: PlantItem) => setPlants(plants.map((p) => (p.id === updatedPlant.id ? updatedPlant : p)));
  const handleDeletePlant = (id: string) => setPlants(plants.filter((p) => p.id !== id));
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
                  onAddSensor={handleAddSensor}
                  onAddToolMapping={handleAddToolMapping}
                  onAddCategory={handleAddCategory}
                  onUpdateCategory={handleUpdateCategory}
                  onDeleteCategory={handleDeleteCategory}
                  onAddIndustryType={handleAddIndustryType}
                  onUpdateIndustryType={handleUpdateIndustryType}
                  onDeleteIndustryType={handleDeleteIndustryType}
                  onAddPlant={handleAddPlant}
                  onUpdatePlant={handleUpdatePlant}
                  onDeletePlant={handleDeletePlant}
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
                clients={clients}
                clientUsers={clientUsers}
                roles={roles}
                manageAccessClientId={manageAccessClientId}
                onBackToClients={backToClients}
                onAddUser={handleAddClientUser}
                onUpdateUser={handleUpdateClientUser}
                onDeleteUser={handleDeleteClientUser}
                onToggleUserStatus={handleToggleClientUserStatus}
                onResetPassword={handleResetClientUserPassword}
              />
            }
          />

          <Route
            path="roles"
            element={
              <RolesPage
                clients={clients}
                clientUsers={clientUsers}
                roles={roles}
                manageAccessClientId={manageAccessClientId}
                onBackToClients={backToClients}
                onAddRole={handleAddRole}
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
