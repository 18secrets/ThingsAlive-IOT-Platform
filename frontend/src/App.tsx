/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  NavigationTab,
  AdminSubTab,
  SensorItem,
  ToolMappingItem,
  CategoryItem,
  EquipmentItem,
  DeviceItem,
  PlantItem,
  IndustryTypeItem,
  ClientAccount,
  AuthUser,
  PlatformUserItem,
  ClientUserItem,
  RoleDefinition,
  CLIENT_ASSIGNABLE_TABS
} from './types';
import {
  INITIAL_SENSORS,
  INITIAL_TOOL_MAPPINGS,
  INITIAL_CATEGORIES,
  INITIAL_EQUIPMENT,
  INITIAL_DEVICES,
  INITIAL_INDUSTRY_TYPES,
  INITIAL_PROTOCOLS,
  INITIAL_PLANTS,
  INITIAL_ONBOARDING_SESSIONS,
  MASTER_ADMIN_CREDENTIALS,
  INITIAL_CLIENTS,
  INITIAL_USERS,
  INITIAL_CLIENT_USERS,
  INITIAL_ROLES
} from './data/mockData';
import { ClientUserManagement } from './components/clients/ClientUserManagement';
import { RoleManagement } from './components/clients/RoleManagement';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { AskAIWidget } from './components/AskAIWidget';
import { AdminManagement } from './components/admin/AdminManagement';
import { DeviceSetup } from './components/devices/DeviceSetup';
import { AIOnboarding } from './components/onboarding/AIOnboarding';
import { OnboardingList } from './components/onboarding/OnboardingList';
import { EquipmentDetailsView } from './components/onboarding/EquipmentDetailsView';
import { LoginScreen } from './components/auth/LoginScreen';
import { AcceptInvitationScreen } from './components/auth/AcceptInvitationScreen';
import { ChangePasswordScreen } from './components/auth/ChangePasswordScreen';
import { MasterAdminDashboard } from './components/dashboard/MasterAdminDashboard';
import { DashboardView } from './components/views/OtherViews';
import { AlertAgentView } from './components/views/AlertAgentView';
import { AlertAIAssistant } from './components/alerts/AlertAIAssistant';
import { WorkflowEditor } from './components/alerts/WorkflowEditor';
import { WorkflowSpec } from './utils/workflowParser';
import { SettingsView } from './components/settings/SettingsView';
import { UsersHub } from './components/users/UsersHub';
import {
  apiSignIn, apiResume, apiSignOut, hasStoredSession, ApiError, SignedInUser,
  apiListAccounts, apiCreateAccount, apiUpdateAccount, apiSuspendAccount, apiReinstateAccount,
  apiResendInvitation, Account, ResendInvitationResult,
} from './lib/api';

const SESSION_KEY = 'ta_session';
const MASTER_ADMIN_PASSWORD_KEY = 'ta_master_admin_password';
const CLIENT_USERS_KEY = 'ta_client_users';
const ROLES_KEY = 'ta_roles';

// Session lives in sessionStorage (per-tab) rather than localStorage
// (shared across tabs), so opening multiple tabs lets each one be logged
// in as a different user independently.
function loadSession(): AuthUser | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// The Master Admin password can be changed from Settings, so it's kept in
// localStorage (shared, since there's only one Master Admin account) rather
// than the hardcoded MASTER_ADMIN_CREDENTIALS constant.
function loadMasterAdminPassword(): string {
  try {
    return localStorage.getItem(MASTER_ADMIN_PASSWORD_KEY) || MASTER_ADMIN_CREDENTIALS.password;
  } catch {
    return MASTER_ADMIN_CREDENTIALS.password;
  }
}

// Backfills a Super Admin user + role for any client that predates the
// per-user login model (e.g. a client sitting in localStorage from before
// this feature shipped) — mirrors the withContactDefaults backfill pattern
// above, so nobody who already created a client gets locked out.
function ensureClientIdentity(
  clients: ClientAccount[],
  users: ClientUserItem[],
  roles: RoleDefinition[]
): { users: ClientUserItem[]; roles: RoleDefinition[] } {
  let nextUsers = users;
  let nextRoles = roles;
  clients.forEach((c) => {
    if (roles.some((r) => r.clientId === c.id)) return;
    const roleId = `role-superadmin-${c.id}`;
    nextRoles = [
      ...nextRoles,
      { id: roleId, clientId: c.id, name: 'Super Admin', allowedTabs: CLIENT_ASSIGNABLE_TABS, isSuperAdminRole: true, createdAt: c.createdAt },
    ];
    nextUsers = [
      ...nextUsers,
      { id: `cu-${c.id}`, clientId: c.id, name: c.contactPersonName, username: c.username, password: c.password, roleId, active: true, mustChangePassword: c.mustChangePassword, createdAt: c.createdAt },
    ];
  });
  return { users: nextUsers, roles: nextRoles };
}

function loadClientUsers(clients: ClientAccount[]): ClientUserItem[] {
  try {
    const raw = localStorage.getItem(CLIENT_USERS_KEY);
    const users: ClientUserItem[] = raw ? JSON.parse(raw) : INITIAL_CLIENT_USERS;
    const roles: RoleDefinition[] = JSON.parse(localStorage.getItem(ROLES_KEY) || 'null') || INITIAL_ROLES;
    return ensureClientIdentity(clients, users, roles).users;
  } catch {
    return INITIAL_CLIENT_USERS;
  }
}

function loadRoles(clients: ClientAccount[]): RoleDefinition[] {
  try {
    const raw = localStorage.getItem(ROLES_KEY);
    const roles: RoleDefinition[] = raw ? JSON.parse(raw) : INITIAL_ROLES;
    const users: ClientUserItem[] = JSON.parse(localStorage.getItem(CLIENT_USERS_KEY) || 'null') || INITIAL_CLIENT_USERS;
    return ensureClientIdentity(clients, users, roles).roles;
  } catch {
    return INITIAL_ROLES;
  }
}

// The backend mints every platform-staff token (master-admin, platform-support,
// catalog-author) with this fixed tenant claim — it isn't a real account, just a
// value the guard needs present (src/platform/platform-token.ts). It's the one
// signal a sign-in response carries for "this was a platform_user, not an
// app_user" — see PlatformCredentialService's own comment on the same constant.
const PLATFORM_TENANT_ID = 'things-alive';

// Builds the app's existing AuthUser shape from a real sign-in/refresh
// response. Real tenant accounts aren't in the mock role/tab system yet, so
// every signed-in one gets the full client tab set for now — narrowing this
// to the account's actual capabilities is its own piece of integration work
// (the Roles & Permissions screen), not something to guess at here.
function authUserFromApi(user: SignedInUser): AuthUser {
  if (user.tenantId === PLATFORM_TENANT_ID) {
    return { role: 'master-admin', username: user.email };
  }
  return {
    role: 'client',
    username: user.email,
    clientId: user.tenantId,
    // The API has no tenant display name on a non-platform token — see
    // src/me/me.controller.ts — so the tenant id is what's shown until a
    // real screen exposes one.
    clientName: user.tenantId,
    userId: user.id,
    roleId: user.roleSlug,
    allowedTabs: CLIENT_ASSIGNABLE_TABS,
    isSuperAdmin: user.roleSlug === 'ceo-manager',
  };
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

export default function App() {
  // Auth state — every sign-in is real now, see lib/api.ts. Accounts (the
  // Clients admin screen) are real too, fetched below. Everything past that
  // (plants, devices, equipment, ...) still reads and writes mock data.
  const [authUser, setAuthUser] = useState<AuthUser | null>(loadSession);
  // True only while resuming a real session on a cold load. Both roles are
  // real sign-ins now (see authUserFromApi), so the only signal that matters
  // is whether a refresh token actually survived the reload.
  const [restoringSession, setRestoringSession] = useState(() => hasStoredSession());
  // Populated from GET /accounts once a Master Admin session exists — see the
  // effect below. Empty for a client session; a tenant has no reason to list
  // every other tenant, and the API would refuse it anyway.
  const [clients, setClients] = useState<ClientAccount[]>([]);
  const [accountsError, setAccountsError] = useState<string | undefined>(undefined);
  const [clientUsers, setClientUsers] = useState<ClientUserItem[]>(() => loadClientUsers([]));
  const [roles, setRoles] = useState<RoleDefinition[]>(() => loadRoles([]));
  const [masterAdminPassword, setMasterAdminPassword] = useState<string>(loadMasterAdminPassword);
  const [authError, setAuthError] = useState<string | undefined>(undefined);
  const [pendingPasswordChange, setPendingPasswordChange] = useState<ClientUserItem | null>(null);
  // Shows AcceptInvitationScreen instead of the login form. A `?invite=` link
  // opens straight into it with the token pre-filled; the login screen also
  // links here for someone who was just handed the token directly.
  const [acceptingInvitation, setAcceptingInvitation] = useState(
    () => new URLSearchParams(window.location.search).has('invite'),
  );
  // Master Admin's optional drill-down into one client's Users/Roles screens.
  const [manageAccessClientId, setManageAccessClientId] = useState<string | null>(null);

  const [currentTab, setCurrentTab] = useState<NavigationTab>('dashboard');
  // A resumed client session should land on a subtab it can actually see —
  // 'sensor' (the master-admin default) is hidden from the client role.
  const [adminSubTab, setAdminSubTab] = useState<AdminSubTab>(() => (loadSession()?.role === 'client' ? 'plant' : 'sensor'));
  const [subRoute, setSubRoute] = useState<'device-setup' | null>(null);
  const [aiOnboardingView, setAiOnboardingView] = useState<'list' | 'chat' | 'equipment-detail'>('list');
  const [alertAgentView, setAlertAgentView] = useState<'list' | 'assistant' | 'workflow'>('list');
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowSpec | null>(null);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(false);

  // Core Data States
  const [sensors, setSensors] = useState<SensorItem[]>(INITIAL_SENSORS);
  const [toolMappings, setToolMappings] = useState<ToolMappingItem[]>(INITIAL_TOOL_MAPPINGS);
  const [categories, setCategories] = useState<CategoryItem[]>(INITIAL_CATEGORIES);
  const [equipmentList, setEquipmentList] = useState<EquipmentItem[]>(INITIAL_EQUIPMENT);
  const [devices, setDevices] = useState<DeviceItem[]>(INITIAL_DEVICES);
  const [industryTypes, setIndustryTypes] = useState<IndustryTypeItem[]>(INITIAL_INDUSTRY_TYPES);
  const [protocols] = useState(INITIAL_PROTOCOLS);
  const [plants, setPlants] = useState<PlantItem[]>(INITIAL_PLANTS);
  const [onboardingSessions, setOnboardingSessions] = useState(INITIAL_ONBOARDING_SESSIONS);
  const [users, setUsers] = useState<PlatformUserItem[]>(INITIAL_USERS);

  // Sync Dark Mode class on document
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  // Resume a real session on a cold load. The cached AuthUser in
  // sessionStorage is what lets the shell render immediately without a
  // flash of the login screen, but it's just what was true at last write —
  // only the API can say whether the refresh token behind it still works.
  useEffect(() => {
    if (!restoringSession) return;
    let live = true;
    (async () => {
      const user = await apiResume();
      if (!live) return;
      if (user) {
        setAuthUser(authUserFromApi(user));
      } else {
        // The refresh token is gone or dead — the cached session was a lie.
        setAuthUser(null);
      }
      setRestoringSession(false);
    })();
    return () => { live = false; };
    // Runs once, on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist session (per-tab)
  useEffect(() => {
    if (authUser) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(authUser));
    } else {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }, [authUser]);

  // Real accounts, fetched fresh on every Master Admin sign-in and again
  // after every create/edit/suspend/reinstate — nothing here is cached
  // locally, unlike the mock data below it. GET /accounts is the only source
  // of truth, so a mutation is followed by re-reading it rather than trusted
  // to have produced the right local state on its own.
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

  // Auth handlers
  const logInAsClientUser = (user: ClientUserItem, client: ClientAccount) => {
    const role = roles.find((r) => r.id === user.roleId);
    setAuthUser({
      role: 'client',
      username: user.username,
      clientId: client.id,
      clientName: client.clientName,
      userId: user.id,
      roleId: user.roleId,
      allowedTabs: role?.allowedTabs || [],
      isSuperAdmin: !!role?.isSuperAdminRole,
    });
    setCurrentTab('dashboard');
  };

  const handleLoginAttempt = async (identifier: string, password: string) => {
    // One real call for everyone now — the backend's own /auth/sign-in decides
    // whether this is a Things Alive staff credential (platform_user) or a
    // tenant account (app_user) and returns the same shape either way. The
    // mock clientUsers lookup and the hardcoded Master Admin check that used
    // to live here are both gone: a user created on the still-mock
    // Clients/Accounts screen doesn't exist in the database, so it can no
    // longer sign in until that screen is wired up too.
    try {
      const user = await apiSignIn(identifier, password);
      setAuthError(undefined);
      setAuthUser(authUserFromApi(user));
      setCurrentTab('dashboard');
    } catch (err) {
      setAuthError(err instanceof ApiError ? err.message : 'Sign-in failed.');
    }
  };

  const handleCompletePasswordChange = (newPassword: string) => {
    if (!pendingPasswordChange) return;
    const updated = { ...pendingPasswordChange, password: newPassword, mustChangePassword: false };
    setClientUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    const client = clients.find((c) => c.id === updated.clientId);
    if (client) logInAsClientUser(updated, client);
    setPendingPasswordChange(null);
  };

  const handleLogout = () => {
    // Best-effort and fire-and-forget: the local session below is cleared
    // either way, so a dead or unreachable server can't trap someone signed in.
    if (authUser) void apiSignOut();
    setAuthUser(null);
    setPendingPasswordChange(null);
    setAuthError(undefined);
    setCurrentTab('dashboard');
    setSubRoute(null);
    setAiOnboardingView('list');
    setAlertAgentView('list');
  };

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

  const handleAddRole = (role: RoleDefinition) => setRoles((prev) => [role, ...prev]);
  const handleUpdateRole = (role: RoleDefinition) => setRoles((prev) => prev.map((r) => (r.id === role.id ? role : r)));
  const handleDeleteRole = (id: string) => setRoles((prev) => prev.filter((r) => r.id !== id));

  const handleAddUser = (newUser: PlatformUserItem) => {
    setUsers((prev) => [newUser, ...prev]);
  };

  const handleUpdateUser = (updatedUser: PlatformUserItem) => {
    setUsers((prev) => prev.map((u) => (u.id === updatedUser.id ? updatedUser : u)));
  };

  const handleDeleteUser = (id: number) => {
    setUsers((prev) => prev.filter((u) => u.id !== id));
  };

  const handleToggleUserStatus = (id: number) => {
    setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, active: !u.active } : u)));
  };

  // Handlers for Add / Update / Delete
  const handleAddSensor = (newSensor: SensorItem) => {
    setSensors([newSensor, ...sensors]);
  };

  const handleAddToolMapping = (newMapping: ToolMappingItem) => {
    setToolMappings([newMapping, ...toolMappings.filter(t => t.id !== newMapping.id)]);
  };

  const handleAddCategory = (newCat: CategoryItem) => {
    setCategories([newCat, ...categories]);
  };

  const handleUpdateCategory = (updatedCat: CategoryItem) => {
    setCategories(categories.map(c => c.id === updatedCat.id ? updatedCat : c));
  };

  const handleDeleteCategory = (id: string) => {
    setCategories(categories.filter(c => c.id !== id));
  };

  const handleAddEquipment = (newEquip: EquipmentItem) => {
    setEquipmentList([newEquip, ...equipmentList]);
  };

  const handleAddPlant = (newPlant: PlantItem) => {
    setPlants([newPlant, ...plants]);
  };

  const handleUpdatePlant = (updatedPlant: PlantItem) => {
    setPlants(plants.map(p => p.id === updatedPlant.id ? updatedPlant : p));
  };

  const handleDeletePlant = (id: string) => {
    setPlants(plants.filter(p => p.id !== id));
  };

  const handleAddIndustryType = (newType: IndustryTypeItem) => {
    setIndustryTypes([newType, ...industryTypes]);
  };

  const handleUpdateIndustryType = (updatedType: IndustryTypeItem) => {
    setIndustryTypes(industryTypes.map(i => i.id === updatedType.id ? updatedType : i));
  };

  const handleDeleteIndustryType = (id: string) => {
    setIndustryTypes(industryTypes.filter(i => i.id !== id));
  };

  const handleAddDevice = (newDevice: DeviceItem) => {
    setDevices([newDevice, ...devices]);
    setSubRoute(null);
    setCurrentTab('admin');
    setAdminSubTab('devices');
  };

  const handleDeleteDevice = (id: number) => {
    setDevices(devices.filter(d => d.id !== id));
  };

  const handleToggleOnboardingActive = (id: string) => {
    setOnboardingSessions(onboardingSessions.map(s => s.id === id ? { ...s, active: !s.active } : s));
  };

  const handleRefreshOnboardingSession = (id: string) => {
    setOnboardingSessions(onboardingSessions.map(s => s.id === id ? { ...s, updatedAt: 'Just now' } : s));
  };

  const handleContinueOnboardingSession = () => {
    setAiOnboardingView('chat');
  };

  const handleViewOnboardingSession = () => {
    setAiOnboardingView('equipment-detail');
  };

  // Compute Page Header Titles based on active view
  let headerTitle = 'Admin';
  let headerSubtitle: string | undefined = 'Master Configuration';
  let headerBreadcrumb: string | undefined = undefined;
  let onBackHandler: (() => void) | undefined = undefined;
  let headerAIIndicator = false;

  if (subRoute === 'device-setup') {
    headerTitle = 'Device Setup';
    headerSubtitle = 'Simplified Setup';
    headerBreadcrumb = 'Device Management';
    onBackHandler = () => setSubRoute(null);
  } else {
    switch (currentTab) {
      case 'admin':
        headerTitle = 'Administration';
        headerSubtitle = 'Master Configuration';
        break;
      case 'ai-onboarding':
        if (aiOnboardingView === 'chat') {
          headerTitle = 'ChatBot Assistant';
          headerSubtitle = 'AI Setup Assistant';
          headerBreadcrumb = 'AI Onboarding';
          onBackHandler = () => setAiOnboardingView('list');
          headerAIIndicator = true;
        } else if (aiOnboardingView === 'equipment-detail') {
          headerTitle = 'Equipment Details';
          headerSubtitle = undefined;
          headerBreadcrumb = 'AI Onboarding';
          onBackHandler = () => setAiOnboardingView('list');
        } else {
          headerTitle = 'AI Onboarding';
          headerSubtitle = 'Guided Setup Sessions';
        }
        break;
      case 'dashboard':
        headerTitle = 'Dashboard';
        headerSubtitle = authUser?.role === 'master-admin' ? 'Platform Overview' : 'Fleet Telematics';
        break;
      case 'alert-agent':
        if (alertAgentView === 'assistant') {
          headerTitle = 'AI Assistant';
          headerSubtitle = undefined;
          onBackHandler = () => setAlertAgentView('list');
          headerAIIndicator = true;
        } else if (alertAgentView === 'workflow') {
          headerTitle = 'Work Flow';
          headerSubtitle = undefined;
          onBackHandler = () => setAlertAgentView('assistant');
          headerAIIndicator = true;
        } else {
          headerTitle = 'Alert Agent';
          headerSubtitle = 'Automated Dispatch';
        }
        break;
      case 'users':
        headerTitle = 'User Management';
        headerSubtitle = 'Access & Permissions';
        break;
      case 'client-users':
        headerTitle = 'Client Users';
        headerSubtitle = 'People & Access';
        break;
      case 'roles':
        headerTitle = 'Roles & Permissions';
        headerSubtitle = 'Page Access Control';
        break;
      case 'settings':
        headerTitle = 'Settings';
        headerSubtitle = 'System Parameters';
        break;
    }
  }

  // Auth gate — nothing below renders until someone is logged in
  if (restoringSession) {
    return (
      <div className="grid min-h-screen w-full place-items-center bg-[#F4F7FB] text-sm text-slate-500 dark:bg-slate-950 dark:text-slate-400">
        Restoring your session…
      </div>
    );
  }
  if (pendingPasswordChange) {
    const pendingClientName = clients.find((c) => c.id === pendingPasswordChange.clientId)?.clientName || 'there';
    return (
      <ChangePasswordScreen
        displayName={pendingClientName}
        currentPassword={pendingPasswordChange.password}
        onSubmit={handleCompletePasswordChange}
      />
    );
  }
  if (!authUser && acceptingInvitation) {
    return (
      <AcceptInvitationScreen
        initialToken={new URLSearchParams(window.location.search).get('invite') ?? undefined}
        onAccepted={(user) => {
          setAuthUser(authUserFromApi(user));
          setAcceptingInvitation(false);
          setCurrentTab('dashboard');
        }}
        onBack={() => setAcceptingInvitation(false)}
      />
    );
  }
  if (!authUser) {
    return (
      <LoginScreen
        onLogin={handleLoginAttempt}
        error={authError}
        onWantAcceptInvitation={() => setAcceptingInvitation(true)}
      />
    );
  }

  // Which client's Plants/Devices/Equipment/Users/Roles are in scope: the
  // signed-in client's own id, or — for Master Admin — whichever client they
  // drilled into via "Manage Access" on the Clients admin subtab.
  const scopeClientId = authUser.role === 'client' ? authUser.clientId : (manageAccessClientId || undefined);
  const scopeClientLabel = authUser.role === 'client'
    ? authUser.clientName
    : clients.find((c) => c.id === manageAccessClientId)?.clientName;

  // A client only ever sees and edits its own fleet — Master Admin's own
  // Administration view is unaffected and keeps seeing every client's data.
  const visiblePlants = authUser.role === 'client' ? plants.filter((p) => p.clientId === authUser.clientId) : plants;
  const visibleDevices = authUser.role === 'client' ? devices.filter((d) => d.clientId === authUser.clientId) : devices;
  const visibleEquipment = authUser.role === 'client' ? equipmentList.filter((e) => e.clientId === authUser.clientId) : equipmentList;
  // Locks the Client picker in Add Plant/Device/Equipment forms to the
  // signed-in client's own account when they're the one creating the record.
  const modalClients = authUser.role === 'client' ? clients.filter((c) => c.id === authUser.clientId) : clients;
  const backToClients = () => {
    setManageAccessClientId(null);
    setCurrentTab('admin');
    setAdminSubTab('clients');
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#F4F7FB] dark:bg-slate-950 font-sans text-slate-800 dark:text-slate-100 transition-colors selection:bg-[#0B7285] selection:text-white">
      {/* Left Sidebar Navigation */}
      <Sidebar
        currentTab={currentTab}
        role={authUser.role}
        clientName={authUser.clientName}
        allowedTabs={authUser.allowedTabs}
        isSuperAdmin={authUser.isSuperAdmin}
        onSelectTab={(tab) => {
          setSubRoute(null);
          setAiOnboardingView('list');
          setAlertAgentView('list');
          setManageAccessClientId(null);
          if (tab === 'admin') {
            setAdminSubTab(authUser.role === 'client' ? 'plant' : 'industry');
          }
          setCurrentTab(tab);
        }}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-[#F4F7FB] dark:bg-slate-950">
        {/* Top Header */}
        <Header 
          title={headerTitle}
          subtitle={headerSubtitle}
          breadcrumb={headerBreadcrumb}
          onBack={onBackHandler}
          isDarkMode={isDarkMode}
          onToggleDarkMode={() => setIsDarkMode(!isDarkMode)}
          aiIndicator={headerAIIndicator}
          onLogout={handleLogout}
        />

        {/* Dynamic Page Views Container */}
        <main className="flex-1 overflow-y-auto p-6 md:p-8 bg-[#F4F7FB] dark:bg-slate-950">
          <div className="max-w-7xl mx-auto space-y-6">
            
            {subRoute === 'device-setup' ? (
              <DeviceSetup
                onBack={() => setSubRoute(null)}
                onSaveDevice={handleAddDevice}
                toolMappings={toolMappings}
                sensors={sensors}
                categories={categories}
                plants={visiblePlants}
                clients={modalClients}
              />
            ) : (
              <>
                {currentTab === 'admin' && (
                  <AdminManagement
                    sensors={sensors}
                    toolMappings={toolMappings}
                    categories={categories}
                    industryTypes={industryTypes}
                    plants={visiblePlants}
                    onAddSensor={handleAddSensor}
                    onAddToolMapping={handleAddToolMapping}
                    onAddCategory={handleAddCategory}
                    onUpdateCategory={handleUpdateCategory}
                    onDeleteCategory={handleDeleteCategory}
                    onAddPlant={handleAddPlant}
                    onUpdatePlant={handleUpdatePlant}
                    onDeletePlant={handleDeletePlant}
                    onAddIndustryType={handleAddIndustryType}
                    onUpdateIndustryType={handleUpdateIndustryType}
                    onDeleteIndustryType={handleDeleteIndustryType}
                    devices={visibleDevices}
                    onNavigateToDeviceSetup={() => setSubRoute('device-setup')}
                    onNavigateToAISetup={
                      authUser.role === 'master-admin'
                        ? undefined
                        : () => { setAiOnboardingView('chat'); setCurrentTab('ai-onboarding'); }
                    }
                    onDeleteDevice={handleDeleteDevice}
                    equipmentList={visibleEquipment}
                    onAddEquipment={handleAddEquipment}
                    activeSubTab={adminSubTab}
                    onChangeSubTab={setAdminSubTab}
                    clients={modalClients}
                    accountsError={accountsError}
                    onCreateAccount={handleCreateAccount}
                    onUpdateAccount={handleUpdateAccount}
                    onResendInvitation={handleResendInvitation}
                    onToggleClientStatus={handleToggleClientStatus}
                    restrictToClientAdmin={authUser.role === 'client'}
                  />
                )}

                {currentTab === 'client-users' && scopeClientId && (
                  <ClientUserManagement
                    scopeClientId={scopeClientId}
                    clientLabel={scopeClientLabel}
                    isMasterAdminView={authUser.role === 'master-admin'}
                    users={clientUsers.filter((u) => u.clientId === scopeClientId)}
                    roles={roles.filter((r) => r.clientId === scopeClientId)}
                    existingUsernames={clientUsers.map((u) => u.username.toLowerCase())}
                    onAddUser={handleAddClientUser}
                    onUpdateUser={handleUpdateClientUser}
                    onDeleteUser={handleDeleteClientUser}
                    onToggleUserStatus={handleToggleClientUserStatus}
                    onResetPassword={handleResetClientUserPassword}
                    onViewRoles={authUser.role === 'master-admin' ? () => setCurrentTab('roles') : undefined}
                    onBackToClients={authUser.role === 'master-admin' ? backToClients : undefined}
                  />
                )}

                {currentTab === 'roles' && scopeClientId && (
                  <RoleManagement
                    scopeClientId={scopeClientId}
                    clientLabel={scopeClientLabel}
                    isMasterAdminView={authUser.role === 'master-admin'}
                    roles={roles.filter((r) => r.clientId === scopeClientId)}
                    users={clientUsers.filter((u) => u.clientId === scopeClientId)}
                    onAddRole={handleAddRole}
                    onUpdateRole={handleUpdateRole}
                    onDeleteRole={handleDeleteRole}
                    onViewUsers={authUser.role === 'master-admin' ? () => setCurrentTab('client-users') : undefined}
                    onBackToClients={authUser.role === 'master-admin' ? backToClients : undefined}
                  />
                )}

                {currentTab === 'dashboard' && (
                  authUser.role === 'master-admin' ? (
                    <MasterAdminDashboard
                      clients={clients}
                      devices={devices}
                      equipmentList={equipmentList}
                      onboardingSessions={onboardingSessions}
                    />
                  ) : (
                    <DashboardView
                      equipment={visibleEquipment}
                      devices={visibleDevices}
                      onNavigateToDevices={() => { setCurrentTab('admin'); setAdminSubTab('devices'); }}
                      onNavigateToEquipment={() => { setCurrentTab('admin'); setAdminSubTab('equipment'); }}
                    />
                  )
                )}

                {currentTab === 'ai-onboarding' && (
                  aiOnboardingView === 'list' ? (
                    <OnboardingList
                      sessions={onboardingSessions}
                      onAddNew={() => setAiOnboardingView('chat')}
                      onViewSession={handleViewOnboardingSession}
                      onEditSession={handleContinueOnboardingSession}
                      onToggleActive={handleToggleOnboardingActive}
                      onRefreshSession={handleRefreshOnboardingSession}
                    />
                  ) : aiOnboardingView === 'equipment-detail' ? (
                    <EquipmentDetailsView />
                  ) : (
                    <AIOnboarding
                      onSkipToManualSetup={() => {
                        setCurrentTab('admin');
                        setAdminSubTab('devices');
                        setSubRoute('device-setup');
                      }}
                    />
                  )
                )}

                {currentTab === 'alert-agent' && (
                  alertAgentView === 'assistant' ? (
                    <AlertAIAssistant
                      onGenerate={(spec) => {
                        setActiveWorkflow(spec);
                        setAlertAgentView('workflow');
                      }}
                    />
                  ) : alertAgentView === 'workflow' && activeWorkflow ? (
                    <WorkflowEditor
                      spec={activeWorkflow}
                      onBack={() => setAlertAgentView('assistant')}
                      onDeploy={() => setAlertAgentView('list')}
                    />
                  ) : (
                    <AlertAgentView onAddAlert={() => setAlertAgentView('assistant')} />
                  )
                )}
                {currentTab === 'users' && (
                  <UsersHub
                    users={users}
                    onAddUser={handleAddUser}
                    onUpdateUser={handleUpdateUser}
                    onDeleteUser={handleDeleteUser}
                    onToggleUserStatus={handleToggleUserStatus}
                    clients={clients}
                    clientUsers={clientUsers}
                    roles={roles}
                    onManageClientAccess={(clientId) => {
                      setManageAccessClientId(clientId);
                      setCurrentTab('client-users');
                    }}
                  />
                )}
                {currentTab === 'settings' && (
                  <SettingsView
                    authUser={authUser}
                    clients={clients}
                    onChangePassword={handleChangeOwnPassword}
                  />
                )}
              </>
            )}

          </div>
        </main>
      </div>

      {/* Floating Ask AI & Help Widget — hidden on pages that are already AI-driven or have their own floating controls */}
      {!(currentTab === 'ai-onboarding' && aiOnboardingView === 'chat') &&
        !(currentTab === 'alert-agent' && alertAgentView !== 'list') && <AskAIWidget />}
    </div>
  );
}
