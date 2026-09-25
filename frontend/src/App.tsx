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
  TemplateAlertRule,
  TemplateKpiFormula,
  TemplatePredictiveRule,
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
  INITIAL_USERS,
  INITIAL_CLIENT_USERS,
  INITIAL_ROLES,
  INITIAL_TEMPLATE_SENSOR_LINKS,
  INITIAL_TEMPLATE_ALERT_RULES,
  INITIAL_TEMPLATE_KPI_FORMULAS,
  INITIAL_TEMPLATE_PREDICTIVE_RULES,
} from './data/mockData';
import { AuthProvider, useAuth } from './lib/AuthProvider';
import { PageHeaderProvider } from './lib/PageHeaderContext';
import { RequireAuth, GuestOnly } from './routes/guards';
import { Shell } from './shell/Shell';
import { LoginScreen } from './components/auth/LoginScreen';
import { AcceptInvitationScreen } from './components/auth/AcceptInvitationScreen';
import { DashboardPage } from './pages/DashboardPage';
import { AdminPage } from './pages/AdminPage';
import { EquipmentTemplateDetailPage } from './pages/EquipmentTemplateDetailPage';
import { EquipmentClassDetailPage } from './pages/EquipmentClassDetailPage';
import { CatalogImportPage } from './pages/CatalogImportPage';
import { DeviceSetupPage } from './pages/DeviceSetupPage';
import { AiOnboardingPage } from './pages/AiOnboardingPage';
import { AlertAgentPage } from './pages/AlertAgentPage';
import { LivePredictionsPage } from './pages/LivePredictionsPage';
import { UsersPage } from './pages/UsersPage';
import { ClientUsersPage } from './pages/ClientUsersPage';
import { RolesPage } from './pages/RolesPage';
import { SettingsPage } from './pages/SettingsPage';
import {
  apiListAccounts, apiCreateAccount, apiUpdateAccount, apiSuspendAccount, apiReinstateAccount,
  apiResendInvitation, apiListPlants, apiCreatePlant, apiUpdatePlant, apiRetirePlant, apiReopenPlant,
  apiListEquipmentClasses, apiCreateEquipmentClass, apiUpdateEquipmentClass,
  apiPublishEquipmentClass, apiRetireEquipmentClass,
  apiListAuthoringScenarios, apiCreateScenario, apiUpdateScenario, apiPublishScenario,
  apiListAuthoringAlertTemplates, apiCreateAlertTemplate, apiUpdateAlertTemplate,
  apiPublishAlertTemplate, apiRetireAlertTemplate,
  apiListCatalogImports, apiUploadCatalogImport, apiGetCatalogImportDiff,
  apiApplyCatalogImport, apiDownloadCatalogTemplate,
  apiListSensorCategories, apiCreateSensorCategory, apiListSensors, apiCreateSensor, apiUpdateSensor,
  apiListToolMappings, apiCreateToolMapping, apiUpdateToolMapping,
  apiListDevicePool, apiRegisterDevices, apiAssignDevices,
  apiListEquipmentTemplates, apiCreateEquipmentTemplate, apiUpdateEquipmentTemplate,
  apiListRoles, apiCreateRole, apiUpdateRole, apiDeleteRole,
  apiListTenantUsers, apiInviteUser, apiSetUserRole, apiSuspendUser, apiReinstateUser,
  apiChangePassword,
  ApiError, Account, ResendInvitationResult, Plant, PlantInput, EquipmentClass, EquipmentClassInput,
  Scenario, ScenarioInput, AlertRuleTemplate, AlertRuleTemplateInput,
  CatalogImportBatch,
  SensorCategory, Sensor, SensorInput, ToolMapping, ToolMappingInput, PooledDevice, RegisterDeviceInput,
  EquipmentTemplate, EquipmentTemplateInput,
  TenantRole, RoleInput, RolePatchInput, TenantUser, InviteUserInput,
} from './lib/api';

const CLIENT_USERS_KEY = 'ta_client_users';
const ROLES_KEY = 'ta_roles';
const TEMPLATE_SENSOR_LINKS_KEY = 'ta_template_sensor_links';
const ALERT_RULES_KEY = 'ta_template_alert_rules';
const KPI_FORMULAS_KEY = 'ta_template_kpi_formulas';
const PREDICTIVE_RULES_KEY = 'ta_template_predictive_rules';

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

// Equipment class configuration is UI-only (no backend yet — see App.tsx's own
// comment where this state is declared), so localStorage is what makes it survive
// a reload or a fresh sign-in on the same machine instead of resetting every time.
function loadTemplateSensorLinks(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(TEMPLATE_SENSOR_LINKS_KEY);
    return raw ? JSON.parse(raw) : INITIAL_TEMPLATE_SENSOR_LINKS;
  } catch {
    return INITIAL_TEMPLATE_SENSOR_LINKS;
  }
}

function loadAlertRules(): TemplateAlertRule[] {
  try {
    const raw = localStorage.getItem(ALERT_RULES_KEY);
    return raw ? JSON.parse(raw) : INITIAL_TEMPLATE_ALERT_RULES;
  } catch {
    return INITIAL_TEMPLATE_ALERT_RULES;
  }
}

function loadKpiFormulas(): TemplateKpiFormula[] {
  try {
    const raw = localStorage.getItem(KPI_FORMULAS_KEY);
    return raw ? JSON.parse(raw) : INITIAL_TEMPLATE_KPI_FORMULAS;
  } catch {
    return INITIAL_TEMPLATE_KPI_FORMULAS;
  }
}

function loadPredictiveRules(): TemplatePredictiveRule[] {
  try {
    const raw = localStorage.getItem(PREDICTIVE_RULES_KEY);
    return raw ? JSON.parse(raw) : INITIAL_TEMPLATE_PREDICTIVE_RULES;
  } catch {
    return INITIAL_TEMPLATE_PREDICTIVE_RULES;
  }
}

// A client's own equipment templates and their sensors/alert rules/KPI formulas —
// same UI-only reasoning as above, but keyed per client id rather than one shared
// key: two different clients on the same machine (or the same browser used to
// review a demo account) must never see each other's, and neither may ever leak
// into Master Admin's own global list.
function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
const clientKey = (base: string, clientId: string) => `${base}_${clientId}`;

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
  const { authUser, restoringSession, signOut } = useAuth();
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
  // Prediction scenarios across every class (task: wire the Templates-styled
  // detail UI to the real catalog instead of the mock TemplatePredictiveRule
  // localStorage layer). Same shape as equipmentClasses: platform-owned,
  // fetched flat, filtered per class in the detail page.
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenariosError, setScenariosError] = useState<string | undefined>(undefined);
  // Alert rule templates across every class — same shape as scenarios above.
  const [alertTemplates, setAlertTemplates] = useState<AlertRuleTemplate[]>([]);
  const [alertTemplatesError, setAlertTemplatesError] = useState<string | undefined>(undefined);
  // Recently uploaded catalog-import workbooks — same platform-owned shape as the
  // classes/scenarios/alert templates above.
  const [catalogImportBatches, setCatalogImportBatches] = useState<CatalogImportBatch[]>([]);
  const [catalogImportBatchesError, setCatalogImportBatchesError] = useState<string | undefined>(undefined);
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
  // Equipment class configuration — UI only, no backend yet. Sensors/alert
  // rules/KPI formulas are all keyed by equipmentTemplateId directly rather than
  // by any separate "Equipment Class" row: the template itself is what they're
  // attached to.
  const [templateSensorLinks, setTemplateSensorLinks] = useState<Record<string, string[]>>(loadTemplateSensorLinks);
  const [alertRules, setAlertRules] = useState<TemplateAlertRule[]>(loadAlertRules);
  const [kpiFormulas, setKpiFormulas] = useState<TemplateKpiFormula[]>(loadKpiFormulas);
  const [predictiveRules, setPredictiveRules] = useState<TemplatePredictiveRule[]>(loadPredictiveRules);
  // This client's own equipment templates — loaded/persisted per clientId below,
  // never touching Master Admin's global equivalents above.
  const [myEquipmentTemplates, setMyEquipmentTemplates] = useState<EquipmentTemplate[]>([]);
  const [myTemplateSensorLinks, setMyTemplateSensorLinks] = useState<Record<string, string[]>>({});
  const [myAlertRules, setMyAlertRules] = useState<TemplateAlertRule[]>([]);
  const [myKpiFormulas, setMyKpiFormulas] = useState<TemplateKpiFormula[]>([]);
  const [myPredictiveRules, setMyPredictiveRules] = useState<TemplatePredictiveRule[]>([]);
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

  const refreshScenarios = async () => {
    try {
      setScenarios(await apiListAuthoringScenarios());
      setScenariosError(undefined);
    } catch (err) {
      setScenariosError(err instanceof ApiError ? err.message : 'Could not load prediction scenarios.');
    }
  };

  useEffect(() => {
    if (restoringSession || authUser?.role !== 'master-admin') return;
    let live = true;
    (async () => {
      try {
        const list = await apiListAuthoringScenarios();
        if (!live) return;
        setScenarios(list);
        setScenariosError(undefined);
      } catch (err) {
        if (live) setScenariosError(err instanceof ApiError ? err.message : 'Could not load prediction scenarios.');
      }
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);

  const refreshAlertTemplates = async () => {
    try {
      setAlertTemplates(await apiListAuthoringAlertTemplates());
      setAlertTemplatesError(undefined);
    } catch (err) {
      setAlertTemplatesError(err instanceof ApiError ? err.message : 'Could not load alert rule templates.');
    }
  };

  useEffect(() => {
    if (restoringSession || authUser?.role !== 'master-admin') return;
    let live = true;
    (async () => {
      try {
        const list = await apiListAuthoringAlertTemplates();
        if (!live) return;
        setAlertTemplates(list);
        setAlertTemplatesError(undefined);
      } catch (err) {
        if (live) setAlertTemplatesError(err instanceof ApiError ? err.message : 'Could not load alert rule templates.');
      }
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);

  const refreshCatalogImports = async () => {
    try {
      setCatalogImportBatches(await apiListCatalogImports());
      setCatalogImportBatchesError(undefined);
    } catch (err) {
      setCatalogImportBatchesError(err instanceof ApiError ? err.message : 'Could not load recent uploads.');
    }
  };

  useEffect(() => {
    if (restoringSession || authUser?.role !== 'master-admin') return;
    let live = true;
    (async () => {
      try {
        const list = await apiListCatalogImports();
        if (!live) return;
        setCatalogImportBatches(list);
        setCatalogImportBatchesError(undefined);
      } catch (err) {
        if (live) setCatalogImportBatchesError(err instanceof ApiError ? err.message : 'Could not load recent uploads.');
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

  // Sensors, their categories, and equipment templates — reference data both roles
  // now read (`device-catalog.read` / `equipment-template.read`, granted to every
  // tenant role): a client's own Equipment Template page needs the real sensor
  // catalog to show attached parameters, and the real template list to find the
  // Master Library class they opened. Tool mappings and the device pool stay
  // master-admin only below — clients have no capability for either.
  useEffect(() => {
    // Wait for the session-resume check: `authUser` can be a cached, optimistic
    // value from sessionStorage before the real access token is confirmed to
    // still work, and firing early sends an authenticated call with no token
    // at all — surfaced to the user as a raw "Bearer token required." error.
    if (restoringSession || !authUser) return;
    let live = true;
    (async () => {
      const [cats, list] = await Promise.all([apiListSensorCategories(), apiListSensors()])
        .catch((err) => {
          if (live) setSensorsError(err instanceof ApiError ? err.message : 'Could not load sensors.');
          return [null, null] as const;
        });
      if (live && cats && list) { setSensorCategories(cats); setRealSensors(list); setSensorsError(undefined); }

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
    if (restoringSession || authUser?.role !== 'master-admin') return;
    let live = true;
    (async () => {
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
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);

  useEffect(() => {
    localStorage.setItem(CLIENT_USERS_KEY, JSON.stringify(clientUsers));
  }, [clientUsers]);

  useEffect(() => {
    localStorage.setItem(ROLES_KEY, JSON.stringify(roles));
  }, [roles]);

  useEffect(() => {
    localStorage.setItem(TEMPLATE_SENSOR_LINKS_KEY, JSON.stringify(templateSensorLinks));
  }, [templateSensorLinks]);

  useEffect(() => {
    localStorage.setItem(ALERT_RULES_KEY, JSON.stringify(alertRules));
  }, [alertRules]);

  useEffect(() => {
    localStorage.setItem(KPI_FORMULAS_KEY, JSON.stringify(kpiFormulas));
  }, [kpiFormulas]);

  useEffect(() => {
    localStorage.setItem(PREDICTIVE_RULES_KEY, JSON.stringify(predictiveRules));
  }, [predictiveRules]);

  // Load this client's own equipment-template config the moment their id is
  // known — not on mount, because it isn't known then. Re-runs if a different
  // client signs in on the same browser, so the previous client's data is
  // never shown to the next one.
  useEffect(() => {
    if (authUser?.role !== 'client' || !authUser.clientId) return;
    const cid = authUser.clientId;
    setMyEquipmentTemplates(loadJson(clientKey('ta_client_equipment_templates', cid), []));
    setMyTemplateSensorLinks(loadJson(clientKey('ta_client_template_sensor_links', cid), {}));
    setMyAlertRules(loadJson(clientKey('ta_client_alert_rules', cid), []));
    setMyKpiFormulas(loadJson(clientKey('ta_client_kpi_formulas', cid), []));
    setMyPredictiveRules(loadJson(clientKey('ta_client_predictive_rules', cid), []));
  }, [authUser?.role, authUser?.clientId]);

  useEffect(() => {
    if (authUser?.role !== 'client' || !authUser.clientId) return;
    localStorage.setItem(clientKey('ta_client_equipment_templates', authUser.clientId), JSON.stringify(myEquipmentTemplates));
  }, [myEquipmentTemplates, authUser?.role, authUser?.clientId]);

  useEffect(() => {
    if (authUser?.role !== 'client' || !authUser.clientId) return;
    localStorage.setItem(clientKey('ta_client_template_sensor_links', authUser.clientId), JSON.stringify(myTemplateSensorLinks));
  }, [myTemplateSensorLinks, authUser?.role, authUser?.clientId]);

  useEffect(() => {
    if (authUser?.role !== 'client' || !authUser.clientId) return;
    localStorage.setItem(clientKey('ta_client_alert_rules', authUser.clientId), JSON.stringify(myAlertRules));
  }, [myAlertRules, authUser?.role, authUser?.clientId]);

  useEffect(() => {
    if (authUser?.role !== 'client' || !authUser.clientId) return;
    localStorage.setItem(clientKey('ta_client_kpi_formulas', authUser.clientId), JSON.stringify(myKpiFormulas));
  }, [myKpiFormulas, authUser?.role, authUser?.clientId]);

  useEffect(() => {
    if (authUser?.role !== 'client' || !authUser.clientId) return;
    localStorage.setItem(clientKey('ta_client_predictive_rules', authUser.clientId), JSON.stringify(myPredictiveRules));
  }, [myPredictiveRules, authUser?.role, authUser?.clientId]);


  // Self-service password change from Settings, for either role — POST
  // /me/change-password, for real. Returns an error message on failure, or null
  // on success. The API revokes every session as part of the change (see
  // CredentialService.changeOwnPassword's own comment), so this signs the caller
  // out shortly after a success response, once they've had a moment to see it.
  const handleChangeOwnPassword = async (currentPassword: string, newPassword: string): Promise<string | null> => {
    try {
      await apiChangePassword(currentPassword, newPassword);
      window.setTimeout(() => signOut(), 1500);
      return null;
    } catch (err) {
      return err instanceof ApiError ? err.message : 'Could not change your password.';
    }
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

  const handleCreateScenario = async (slug: string, equipmentClassSlug: string, input: ScenarioInput) => {
    const created = await apiCreateScenario(slug, equipmentClassSlug, input);
    await refreshScenarios();
    return created;
  };

  const handleUpdateScenario = async (slug: string, input: ScenarioInput) => {
    const updated = await apiUpdateScenario(slug, input);
    await refreshScenarios();
    return updated;
  };

  const handlePublishScenario = async (slug: string) => {
    try {
      await apiPublishScenario(slug);
      await refreshScenarios();
    } catch (err) {
      setScenariosError(err instanceof ApiError ? err.message : 'Could not publish.');
    }
  };

  const handleCreateAlertTemplate = async (
    slug: string, equipmentClassSlug: string, input: AlertRuleTemplateInput,
  ) => {
    const created = await apiCreateAlertTemplate(slug, equipmentClassSlug, input);
    await refreshAlertTemplates();
    return created;
  };

  const handleUpdateAlertTemplate = async (slug: string, input: AlertRuleTemplateInput) => {
    const updated = await apiUpdateAlertTemplate(slug, input);
    await refreshAlertTemplates();
    return updated;
  };

  const handlePublishAlertTemplate = async (slug: string) => {
    try {
      await apiPublishAlertTemplate(slug);
      await refreshAlertTemplates();
    } catch (err) {
      setAlertTemplatesError(err instanceof ApiError ? err.message : 'Could not publish.');
    }
  };

  const handleRetireAlertTemplate = async (slug: string) => {
    try {
      await apiRetireAlertTemplate(slug);
      await refreshAlertTemplates();
    } catch (err) {
      setAlertTemplatesError(err instanceof ApiError ? err.message : 'Could not retire.');
    }
  };

  const handleUploadCatalogImport = async (file: File) => {
    const result = await apiUploadCatalogImport(file);
    await refreshCatalogImports();
    return result;
  };

  const handleLoadCatalogImportDiff = (id: string) => apiGetCatalogImportDiff(id);

  const handleApplyCatalogImport = async (id: string) => {
    const summary = await apiApplyCatalogImport(id);
    // The workbook can create or version classes, scenarios and alert templates —
    // every screen that already lists those needs to see the result without a reload.
    await Promise.all([
      refreshCatalogImports(), refreshEquipmentClasses(), refreshScenarios(), refreshAlertTemplates(),
    ]);
    return summary;
  };

  const handleDownloadCatalogTemplate = async () => {
    const blob = await apiDownloadCatalogTemplate();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'equipment-library-template.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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

  const handleOpenEquipmentTemplate = (templateId: string) => navigate(`/admin/equipment-template/${templateId}`);

  const handleOpenEquipmentClass = (slug: string) => navigate(`/admin/category/${slug}`);

  const handleOpenCatalogImport = () => navigate('/admin/catalog-import');

  const handleAttachTemplateSensor = (templateId: string, sensorId: string) =>
    setTemplateSensorLinks((prev) => ({
      ...prev,
      [templateId]: [...new Set([...(prev[templateId] ?? []), sensorId])],
    }));

  const handleDetachTemplateSensor = (templateId: string, sensorId: string) =>
    setTemplateSensorLinks((prev) => ({
      ...prev,
      [templateId]: (prev[templateId] ?? []).filter((id) => id !== sensorId),
    }));

  const handleCreateAlertRule = (rule: Omit<TemplateAlertRule, 'id' | 'createdAt'>) =>
    setAlertRules((prev) => [
      { ...rule, id: `alert-${Date.now()}`, createdAt: new Date().toISOString() },
      ...prev,
    ]);
  const handleUpdateAlertRule = (rule: TemplateAlertRule) =>
    setAlertRules((prev) => prev.map((r) => (r.id === rule.id ? rule : r)));
  const handleDeleteAlertRule = (id: string) =>
    setAlertRules((prev) => prev.filter((r) => r.id !== id));

  const handleCreateKpiFormula = (formula: Omit<TemplateKpiFormula, 'id' | 'createdAt'>) =>
    setKpiFormulas((prev) => [
      { ...formula, id: `kpi-${Date.now()}`, createdAt: new Date().toISOString() },
      ...prev,
    ]);
  const handleUpdateKpiFormula = (formula: TemplateKpiFormula) =>
    setKpiFormulas((prev) => prev.map((f) => (f.id === formula.id ? formula : f)));
  const handleDeleteKpiFormula = (id: string) =>
    setKpiFormulas((prev) => prev.filter((f) => f.id !== id));

  const handleCreatePredictiveRule = (rule: Omit<TemplatePredictiveRule, 'id' | 'createdAt'>) =>
    setPredictiveRules((prev) => [
      { ...rule, id: `pred-${Date.now()}`, createdAt: new Date().toISOString() },
      ...prev,
    ]);
  const handleUpdatePredictiveRule = (rule: TemplatePredictiveRule) =>
    setPredictiveRules((prev) => prev.map((r) => (r.id === rule.id ? rule : r)));
  const handleDeletePredictiveRule = (id: string) =>
    setPredictiveRules((prev) => prev.filter((r) => r.id !== id));

  // This client's own equipment templates — created/edited entirely client-side
  // (no API), mirroring the Master Admin handlers above one-for-one but writing
  // to the client-scoped state instead. Never touches `equipmentTemplates`,
  // `templateSensorLinks`, `alertRules` or `kpiFormulas`.
  const handleCreateMyEquipmentTemplate = async (input: EquipmentTemplateInput): Promise<EquipmentTemplate> => {
    const now = new Date().toISOString();
    const created: EquipmentTemplate = {
      id: `my-template-${Date.now()}`,
      name: input.name ?? '',
      category: input.category ?? null,
      manufacturer: input.manufacturer ?? null,
      engineType: input.engineType ?? null,
      fuelTankCapacityLiters: input.fuelTankCapacityLiters ?? null,
      serviceIntervalHours: input.serviceIntervalHours ?? null,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
    };
    setMyEquipmentTemplates((prev) => [created, ...prev]);
    return created;
  };

  const handleUpdateMyEquipmentTemplate = async (id: string, input: EquipmentTemplateInput): Promise<EquipmentTemplate> => {
    const existing = myEquipmentTemplates.find((t) => t.id === id);
    if (!existing) throw new Error('Template not found.');
    const updated: EquipmentTemplate = {
      ...existing,
      name: input.name ?? existing.name,
      category: input.category ?? existing.category,
      manufacturer: input.manufacturer ?? existing.manufacturer,
      engineType: input.engineType ?? existing.engineType,
      fuelTankCapacityLiters: input.fuelTankCapacityLiters ?? existing.fuelTankCapacityLiters,
      serviceIntervalHours: input.serviceIntervalHours ?? existing.serviceIntervalHours,
      description: input.description ?? existing.description,
      updatedAt: new Date().toISOString(),
    };
    setMyEquipmentTemplates((prev) => prev.map((t) => (t.id === id ? updated : t)));
    return updated;
  };

  const handleOpenMyEquipmentTemplate = (templateId: string) => navigate(`/admin/equipment-template/${templateId}`);

  const handleAttachMyTemplateSensor = (templateId: string, sensorId: string) =>
    setMyTemplateSensorLinks((prev) => ({
      ...prev,
      [templateId]: [...new Set([...(prev[templateId] ?? []), sensorId])],
    }));

  const handleDetachMyTemplateSensor = (templateId: string, sensorId: string) =>
    setMyTemplateSensorLinks((prev) => ({
      ...prev,
      [templateId]: (prev[templateId] ?? []).filter((id) => id !== sensorId),
    }));

  const handleCreateMyAlertRule = (rule: Omit<TemplateAlertRule, 'id' | 'createdAt'>) =>
    setMyAlertRules((prev) => [
      { ...rule, id: `my-alert-${Date.now()}`, createdAt: new Date().toISOString() },
      ...prev,
    ]);
  const handleUpdateMyAlertRule = (rule: TemplateAlertRule) =>
    setMyAlertRules((prev) => prev.map((r) => (r.id === rule.id ? rule : r)));
  const handleDeleteMyAlertRule = (id: string) =>
    setMyAlertRules((prev) => prev.filter((r) => r.id !== id));

  const handleCreateMyKpiFormula = (formula: Omit<TemplateKpiFormula, 'id' | 'createdAt'>) =>
    setMyKpiFormulas((prev) => [
      { ...formula, id: `my-kpi-${Date.now()}`, createdAt: new Date().toISOString() },
      ...prev,
    ]);
  const handleUpdateMyKpiFormula = (formula: TemplateKpiFormula) =>
    setMyKpiFormulas((prev) => prev.map((f) => (f.id === formula.id ? formula : f)));
  const handleDeleteMyKpiFormula = (id: string) =>
    setMyKpiFormulas((prev) => prev.filter((f) => f.id !== id));

  const handleCreateMyPredictiveRule = (rule: Omit<TemplatePredictiveRule, 'id' | 'createdAt'>) =>
    setMyPredictiveRules((prev) => [
      { ...rule, id: `my-pred-${Date.now()}`, createdAt: new Date().toISOString() },
      ...prev,
    ]);
  const handleUpdateMyPredictiveRule = (rule: TemplatePredictiveRule) =>
    setMyPredictiveRules((prev) => prev.map((r) => (r.id === rule.id ? rule : r)));
  const handleDeleteMyPredictiveRule = (id: string) =>
    setMyPredictiveRules((prev) => prev.filter((r) => r.id !== id));

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

  const templateSensorCounts = Object.fromEntries(
    equipmentTemplates.map((t) => [t.id, (templateSensorLinks[t.id] ?? []).length]),
  );
  const templateAlertCounts = Object.fromEntries(
    equipmentTemplates.map((t) => [t.id, alertRules.filter((r) => r.equipmentTemplateId === t.id).length]),
  );
  const templateKpiCounts = Object.fromEntries(
    equipmentTemplates.map((t) => [t.id, kpiFormulas.filter((f) => f.equipmentTemplateId === t.id).length]),
  );
  const myTemplateSensorCounts = Object.fromEntries(
    myEquipmentTemplates.map((t) => [t.id, (myTemplateSensorLinks[t.id] ?? []).length]),
  );
  const myTemplateAlertCounts = Object.fromEntries(
    myEquipmentTemplates.map((t) => [t.id, myAlertRules.filter((r) => r.equipmentTemplateId === t.id).length]),
  );
  const myTemplateKpiCounts = Object.fromEntries(
    myEquipmentTemplates.map((t) => [t.id, myKpiFormulas.filter((f) => f.equipmentTemplateId === t.id).length]),
  );

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
                masterEquipmentTemplates={equipmentTemplates}
                myEquipmentTemplates={myEquipmentTemplates}
                templateSensorLinks={templateSensorLinks}
                myTemplateSensorLinks={myTemplateSensorLinks}
                alertRules={alertRules}
                myAlertRules={myAlertRules}
                realSensors={realSensors}
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
              path="catalog-import"
              element={
                <CatalogImportPage
                  batches={catalogImportBatches}
                  batchesError={catalogImportBatchesError}
                  onDownloadTemplate={handleDownloadCatalogTemplate}
                  onUpload={handleUploadCatalogImport}
                  onLoadDiff={handleLoadCatalogImportDiff}
                  onApply={handleApplyCatalogImport}
                />
              }
            />
            <Route
              path="category/:slug"
              element={
                <EquipmentClassDetailPage
                  classes={equipmentClasses}
                  scenarios={scenarios}
                  scenariosError={scenariosError}
                  onCreateScenario={handleCreateScenario}
                  onUpdateScenario={handleUpdateScenario}
                  onPublishScenario={handlePublishScenario}
                  alertTemplates={alertTemplates}
                  alertTemplatesError={alertTemplatesError}
                  onCreateAlertTemplate={handleCreateAlertTemplate}
                  onUpdateAlertTemplate={handleUpdateAlertTemplate}
                  onPublishAlertTemplate={handlePublishAlertTemplate}
                  onRetireAlertTemplate={handleRetireAlertTemplate}
                />
              }
            />
            <Route
              path="equipment-template/:templateId"
              element={
                <EquipmentTemplateDetailPage
                  // A client can only ever reach this route for one of their own
                  // templates (the master library has no "Configure" link for
                  // them) — so which data source feeds this page is decided once,
                  // here, by role, rather than threading role checks through the
                  // page itself.
                  //
                  // Alert rules, KPI formulas and predictive rules are different
                  // from sensors/the template itself: Master Admin's rules are the
                  // account's defaults and stay visible (read-only) to every
                  // client, alongside whatever a client has additionally authored
                  // for themselves — so both `x` (master) and `myX` (client-owned,
                  // only when signed in as a client) are always passed down. A
                  // client's own create/update/delete only ever touches `myX`;
                  // Master Admin's own create/update/delete only ever touches `x`.
                  isClientView={authUser?.role === 'client'}
                  // A client reaches this route either for one of their own invented
                  // templates, or for a Master Library class they opened to layer their
                  // own alerts/KPIs/predictive rules on top of — so both lists are
                  // searched, master's real template id included.
                  templates={authUser?.role === 'client' ? [...equipmentTemplates, ...myEquipmentTemplates] : equipmentTemplates}
                  allSensors={realSensors}
                  sensorCategories={sensorCategories}
                  templateSensorLinks={authUser?.role === 'client' ? myTemplateSensorLinks : templateSensorLinks}
                  onAttachSensor={authUser?.role === 'client' ? handleAttachMyTemplateSensor : handleAttachTemplateSensor}
                  onDetachSensor={authUser?.role === 'client' ? handleDetachMyTemplateSensor : handleDetachTemplateSensor}
                  alertRules={alertRules}
                  onCreateAlertRule={handleCreateAlertRule}
                  onUpdateAlertRule={handleUpdateAlertRule}
                  onDeleteAlertRule={handleDeleteAlertRule}
                  myAlertRules={authUser?.role === 'client' ? myAlertRules : undefined}
                  onCreateMyAlertRule={handleCreateMyAlertRule}
                  onUpdateMyAlertRule={handleUpdateMyAlertRule}
                  onDeleteMyAlertRule={handleDeleteMyAlertRule}
                  kpiFormulas={kpiFormulas}
                  onCreateKpiFormula={handleCreateKpiFormula}
                  onUpdateKpiFormula={handleUpdateKpiFormula}
                  onDeleteKpiFormula={handleDeleteKpiFormula}
                  myKpiFormulas={authUser?.role === 'client' ? myKpiFormulas : undefined}
                  onCreateMyKpiFormula={handleCreateMyKpiFormula}
                  onUpdateMyKpiFormula={handleUpdateMyKpiFormula}
                  onDeleteMyKpiFormula={handleDeleteMyKpiFormula}
                  predictiveRules={predictiveRules}
                  onCreatePredictiveRule={handleCreatePredictiveRule}
                  onUpdatePredictiveRule={handleUpdatePredictiveRule}
                  onDeletePredictiveRule={handleDeletePredictiveRule}
                  myPredictiveRules={authUser?.role === 'client' ? myPredictiveRules : undefined}
                  onCreateMyPredictiveRule={handleCreateMyPredictiveRule}
                  onUpdateMyPredictiveRule={handleUpdateMyPredictiveRule}
                  onDeleteMyPredictiveRule={handleDeleteMyPredictiveRule}
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
                  onOpenEquipmentClass={handleOpenEquipmentClass}
                  onOpenCatalogImport={handleOpenCatalogImport}
                  equipmentTemplates={equipmentTemplates}
                  equipmentTemplatesError={equipmentTemplatesError}
                  onCreateEquipmentTemplate={handleCreateEquipmentTemplate}
                  onUpdateEquipmentTemplate={handleUpdateEquipmentTemplate}
                  onOpenEquipmentTemplate={handleOpenEquipmentTemplate}
                  templateSensorCounts={templateSensorCounts}
                  templateAlertCounts={templateAlertCounts}
                  templateKpiCounts={templateKpiCounts}
                  myEquipmentTemplates={myEquipmentTemplates}
                  onCreateMyEquipmentTemplate={handleCreateMyEquipmentTemplate}
                  onUpdateMyEquipmentTemplate={handleUpdateMyEquipmentTemplate}
                  onOpenMyEquipmentTemplate={handleOpenMyEquipmentTemplate}
                  myTemplateSensorCounts={myTemplateSensorCounts}
                  myTemplateAlertCounts={myTemplateAlertCounts}
                  myTemplateKpiCounts={myTemplateKpiCounts}
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
          <Route path="predictions" element={<LivePredictionsPage />} />

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
