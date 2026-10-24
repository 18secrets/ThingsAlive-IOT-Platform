/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  SensorItem,
  ToolMappingItem,
  CategoryItem,
  PlantItem,
  ClientAccount,
  firstAdminSubTab,
} from './types';
import {
  INITIAL_SENSORS,
  INITIAL_TOOL_MAPPINGS,
  INITIAL_CATEGORIES,
  INITIAL_PLANTS,
} from './data/mockData';
import i18n from './i18n';
import { AuthProvider, useAuth } from './lib/AuthProvider';
import { PageHeaderProvider } from './lib/PageHeaderContext';
import { RequireAuth, GuestOnly } from './routes/guards';
import { Shell } from './shell/Shell';
import { LoginScreen } from './components/auth/LoginScreen';
import { AcceptInvitationScreen } from './components/auth/AcceptInvitationScreen';
import { ForgotPasswordScreen } from './components/auth/ForgotPasswordScreen';
import { DashboardPage } from './pages/DashboardPage';
import { AdminPage } from './pages/AdminPage';
import { EquipmentPagePage } from './pages/EquipmentPagePage';
import { SitePagePage } from './pages/SitePagePage';
import { EquipmentClassDetailPage } from './pages/EquipmentClassDetailPage';
import { CatalogImportPage } from './pages/CatalogImportPage';
import { DeviceSetupPage } from './pages/DeviceSetupPage';
import { AiOnboardingPage } from './pages/AiOnboardingPage';
import { AlertAgentPage } from './pages/AlertAgentPage';
import { DraftsPage } from './pages/DraftsPage';
import { AlertsPage } from './pages/AlertsPage';
import { ThingsCarePage } from './pages/ThingsCarePage';
import { ThingsCareDetailPage } from './pages/ThingsCareDetailPage';
import { ThingsShieldPage } from './pages/ThingsShieldPage';
import { ThingsShieldDetailPage } from './pages/ThingsShieldDetailPage';
import { IncidentManagementPage } from './pages/IncidentManagementPage';
import { ProductionMonitoringPage } from './pages/ProductionMonitoringPage';
import { ProductionMonitoringDetailPage } from './pages/ProductionMonitoringDetailPage';
import { LivePredictionsPage } from './pages/LivePredictionsPage';
import { ThingDetailLivePage } from './pages/ThingDetailLivePage';
import { ScenariosPage } from './pages/ScenariosPage';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { WorkOrdersPage } from './pages/WorkOrdersPage';
import { CostAdministrationPage } from './pages/CostAdministrationPage';
import { ClientUsersPage } from './pages/ClientUsersPage';
import { RolesPage } from './pages/RolesPage';
import { SettingsPage } from './pages/SettingsPage';
import {
  apiListAccounts, apiCreateAccount, apiUpdateAccount, apiSuspendAccount, apiReinstateAccount, apiDeleteAccount,
  apiResendInvitation, apiListPlants, apiCreatePlant, apiUpdatePlant, apiRetirePlant, apiReopenPlant,
  apiSetPlantBoundary, apiImportEquipmentFromMirror,
  apiListEquipmentClasses, apiCreateEquipmentClass, apiUpdateEquipmentClass,
  apiPublishEquipmentClass, apiRetireEquipmentClass, apiUnretireEquipmentClass,
  apiListNamedFormulas, apiCreateNamedFormula, apiEditNamedFormula, apiPublishNamedFormula,
  apiListAuthoringScenarios, apiCreateScenario, apiUpdateScenario, apiPublishScenario,
  apiListAuthoringAlertTemplates, apiCreateAlertTemplate, apiUpdateAlertTemplate,
  apiListAuthoringCausalChains, apiDraftCausalChain, apiPublishCausalChain,
  apiPublishAlertTemplate, apiRetireAlertTemplate,
  apiListCatalogImports, apiUploadCatalogImport, apiGetCatalogImportDiff,
  apiApplyCatalogImport, apiDiscardCatalogImport, apiReviewCatalogImportSensors, apiDownloadCatalogTemplate,
  apiListEntitlements, apiGrantEntitlement, apiRevokeEntitlement,
  apiListMyEquipmentClasses, apiListEquipment, apiListAllEquipment, apiCreateEquipment, apiUpdateEquipment, apiMoveEquipment, apiRetireEquipment,
  apiGetEquipmentPlacementHistory,
  apiListMyDevices, apiClaimDevice, apiUnclaimDevice,
  apiGetEquipmentCoverage, apiGetBindingDiscovery, apiProposeOrActivateBinding,
  apiListEquipmentKpis, apiListMyCatalogScenarios, apiListActivations, apiActivationTransition,
  apiGetActivationHistory, apiGetEquipmentRecommendations,
  apiListPlatformStaff, apiInvitePlatformStaff, apiSetPlatformStaffRole,
  apiSuspendPlatformStaff, apiReinstatePlatformStaff, apiDeletePlatformStaff,
  apiListSensorCategories, apiCreateSensorCategory, apiListSensors, apiCreateSensor, apiUpdateSensor,
  apiRetireSensorCategory, apiUnretireSensorCategory, apiDeleteSensorCategory, apiRenameSensorCategory,
  apiRetireSensor, apiUnretireSensor, apiDeleteSensor,
  apiListToolMappings, apiCreateToolMapping, apiUpdateToolMapping, apiDeleteToolMapping,
  apiListIndustryTypes, apiCreateIndustryType, apiUpdateIndustryType, apiDeleteIndustryType,
  apiListUnmatchedIndustries, apiRematchIndustries, IndustryType, IndustryTypeInput, UnmatchedIndustry,
  apiListSignalAliases, apiUpsertSignalAlias, apiDeleteSignalAlias,
  apiListSignalStates, apiReplaceSignalStates,
  apiListDevicePool, apiRegisterDevices, apiAssignDevices,
  apiReleaseDevices, apiRetireDevices, apiReturnDevicesToStock, apiUpdateDevice,
  apiListRoles, apiCreateRole, apiUpdateRole, apiDeleteRole,
  apiListTenantUsers, apiInviteUser, apiSetUserRole, apiSuspendUser, apiReinstateUser, apiDeleteUser, apiSetUserAccess,
  apiChangePassword,
  ApiError, Account, ResendInvitationResult, Plant, PlantInput, EquipmentClass, EquipmentClassInput,
  Scenario, ScenarioInput, AlertRuleTemplate, AlertRuleTemplateInput, CausalChain, CausalChainInput,
  CatalogImportBatch, SensorReviewSelection, Entitlement, PlatformStaffMember, PlatformStaffRole, InvitePlatformStaffResult,
  NamedFormula, NamedFormulaInput,
  SensorCategory, Sensor, SensorInput, ToolMapping, ToolMappingInput, SignalAlias, SignalAliasInput,
  SignalStateVocabEntry, SignalStateCode, GeoJsonPolygon, ImportResult, PooledDevice, RegisterDeviceInput,
  EquipmentProfile, EquipmentInput,
  MyDevice, CoverageResult, DiscoveryResult, ProposeOrActivateBindingInput, SignalBindingVersion,
  KpiEnvelope, ClientScenario, ActivationView, ActivationAction,
  TenantRole, RoleInput, RolePatchInput, TenantUser, InviteUserInput, SetUserAccessInput,
} from './lib/api';


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
  // Clients/Staff/Devices/Equipment moved to their own sidebar entries
  // (2026-10-10, Shell.tsx's ADMIN_PROMOTED_SUBTABS) — landing on bare
  // /admin now defaults to a tab that's actually still in the sub-tab bar.
  return <Navigate to={`/admin/${firstAdminSubTab(authUser?.role === 'client')}`} replace />;
}

function AppData() {
  const { authUser, restoringSession, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

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
  // Physics shared across classes (Named Formulas admin screen) — platform-owned,
  // same shape as equipmentClasses above.
  const [namedFormulas, setNamedFormulas] = useState<NamedFormula[]>([]);
  const [namedFormulasError, setNamedFormulasError] = useState<string | undefined>(undefined);
  // Prediction scenarios across every class. Same shape as equipmentClasses:
  // platform-owned, fetched flat, filtered per class in the detail page.
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenariosError, setScenariosError] = useState<string | undefined>(undefined);
  // Alert rule templates across every class — same shape as scenarios above.
  const [alertTemplates, setAlertTemplates] = useState<AlertRuleTemplate[]>([]);
  const [causalChains, setCausalChains] = useState<CausalChain[]>([]);
  const [causalChainsError, setCausalChainsError] = useState<string | undefined>(undefined);
  const [alertTemplatesError, setAlertTemplatesError] = useState<string | undefined>(undefined);
  // Recently uploaded catalog-import workbooks — same platform-owned shape as the
  // classes/scenarios/alert templates above.
  const [catalogImportBatches, setCatalogImportBatches] = useState<CatalogImportBatch[]>([]);
  const [catalogImportBatchesError, setCatalogImportBatchesError] = useState<string | undefined>(undefined);
  // Every tenant's grants, across the whole platform — same platform-owned shape as
  // the classes/scenarios/alert templates above; filtered per client in ClientManagement.
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [entitlementsError, setEntitlementsError] = useState<string | undefined>(undefined);
  // The client's own real equipment register (/equipment) and the published classes
  // they're entitled to (/catalog/equipment-classes) — both tenant-scoped off the
  // caller's own token, so only fetched for the client role, same as realPlants.
  const [realEquipment, setRealEquipment] = useState<EquipmentProfile[]>([]);
  const [realEquipmentError, setRealEquipmentError] = useState<string | undefined>(undefined);
  // Every account's equipment in one read (GET /equipment/all) — Master Admin's own
  // Equipment sidebar page, separate from realEquipment above which is tenant-scoped
  // and empty for a platform role.
  const [allEquipment, setAllEquipment] = useState<EquipmentProfile[]>([]);
  const [allEquipmentError, setAllEquipmentError] = useState<string | undefined>(undefined);
  const [myEquipmentClasses, setMyEquipmentClasses] = useState<EquipmentClass[]>([]);
  const [myEquipmentClassesError, setMyEquipmentClassesError] = useState<string | undefined>(undefined);
  // The client's own devices (/inventory/mine) — fitted to a machine or not, for
  // the signal-binding panel's "claim a device" step.
  const [myDevices, setMyDevices] = useState<MyDevice[]>([]);
  const [myDevicesError, setMyDevicesError] = useState<string | undefined>(undefined);
  // Things Alive's own staff (/platform/staff) — master admin only, same reasoning
  // as accounts: real data, not tenant data, so no client-id scoping anywhere here.
  const [platformStaff, setPlatformStaff] = useState<PlatformStaffMember[]>([]);
  const [platformStaffError, setPlatformStaffError] = useState<string | undefined>(undefined);
  // Master Admin's real reference data for wiring a device before it exists —
  // separate from the mock `sensors`/`toolMappings`/`devices` below, which
  // still feed Equipment's still-mock pickers and the client's still-mock
  // Devices tab.
  const [sensorCategories, setSensorCategories] = useState<SensorCategory[]>([]);
  const [realSensors, setRealSensors] = useState<Sensor[]>([]);
  const [showRetiredSensors, setShowRetiredSensors] = useState(false);
  const [sensorsError, setSensorsError] = useState<string | undefined>(undefined);
  const [realToolMappings, setRealToolMappings] = useState<ToolMapping[]>([]);
  const [toolMappingsError, setToolMappingsError] = useState<string | undefined>(undefined);
  const [signalAliases, setSignalAliases] = useState<SignalAlias[]>([]);
  const [signalAliasesError, setSignalAliasesError] = useState<string | undefined>(undefined);
  const [signalStates, setSignalStates] = useState<SignalStateVocabEntry[]>([]);
  const [signalStatesError, setSignalStatesError] = useState<string | undefined>(undefined);
  const [devicePool, setDevicePool] = useState<PooledDevice[]>([]);
  const [devicePoolError, setDevicePoolError] = useState<string | undefined>(undefined);
  // The signed-in client's own real roles/users (/identity/roles, /identity/users).
  // Master Admin has no cross-client view of them: the mock one was removed 2026-10-21,
  // because only a client's own super admin may list its people.
  const [tenantRoles, setTenantRoles] = useState<TenantRole[]>([]);
  const [rolesError, setRolesError] = useState<string | undefined>(undefined);
  const [tenantUsers, setTenantUsers] = useState<TenantUser[]>([]);
  const [usersError, setUsersError] = useState<string | undefined>(undefined);
  // Master Admin's optional drill-down into one client's Users/Roles screens.
  const [manageAccessClientId, setManageAccessClientId] = useState<string | null>(null);

  const [sensors, setSensors] = useState<SensorItem[]>(INITIAL_SENSORS);
  const [toolMappings, setToolMappings] = useState<ToolMappingItem[]>(INITIAL_TOOL_MAPPINGS);
  const [categories, setCategories] = useState<CategoryItem[]>(INITIAL_CATEGORIES);
  const [industryTypes, setIndustryTypes] = useState<IndustryType[]>([]);
  const [industryTypesError, setIndustryTypesError] = useState<string | undefined>(undefined);
  const [unmatchedIndustries, setUnmatchedIndustries] = useState<UnmatchedIndustry[]>([]);
  const [plants, setPlants] = useState<PlantItem[]>(INITIAL_PLANTS);

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

  const refreshNamedFormulas = async () => {
    try {
      setNamedFormulas(await apiListNamedFormulas());
      setNamedFormulasError(undefined);
    } catch (err) {
      setNamedFormulasError(err instanceof ApiError ? err.message : 'Could not load named formulas.');
    }
  };

  useEffect(() => {
    if (restoringSession || authUser?.role !== 'master-admin') return;
    let live = true;
    (async () => {
      try {
        const list = await apiListNamedFormulas();
        if (!live) return;
        setNamedFormulas(list);
        setNamedFormulasError(undefined);
      } catch (err) {
        if (live) setNamedFormulasError(err instanceof ApiError ? err.message : 'Could not load named formulas.');
      }
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);

  const refreshEntitlements = async () => {
    try {
      setEntitlements(await apiListEntitlements());
      setEntitlementsError(undefined);
    } catch (err) {
      setEntitlementsError(err instanceof ApiError ? err.message : 'Could not load entitlements.');
    }
  };

  useEffect(() => {
    if (restoringSession || authUser?.role !== 'master-admin') return;
    let live = true;
    (async () => {
      try {
        const list = await apiListEntitlements();
        if (!live) return;
        setEntitlements(list);
        setEntitlementsError(undefined);
      } catch (err) {
        if (live) setEntitlementsError(err instanceof ApiError ? err.message : 'Could not load entitlements.');
      }
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);

  const refreshEquipment = async () => {
    try {
      setRealEquipment(await apiListEquipment());
      setRealEquipmentError(undefined);
    } catch (err) {
      setRealEquipmentError(err instanceof ApiError ? err.message : 'Could not load equipment.');
    }
  };

  const refreshAllEquipment = async () => {
    try {
      setAllEquipment(await apiListAllEquipment());
      setAllEquipmentError(undefined);
    } catch (err) {
      setAllEquipmentError(err instanceof ApiError ? err.message : 'Could not load equipment.');
    }
  };

  useEffect(() => {
    if (restoringSession || authUser?.role !== 'client') return;
    let live = true;
    (async () => {
      try {
        const list = await apiListEquipment();
        if (!live) return;
        setRealEquipment(list);
        setRealEquipmentError(undefined);
      } catch (err) {
        if (live) setRealEquipmentError(err instanceof ApiError ? err.message : 'Could not load equipment.');
      }
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);

  useEffect(() => {
    if (restoringSession || authUser?.role !== 'master-admin') return;
    let live = true;
    (async () => {
      try {
        const list = await apiListAllEquipment();
        if (!live) return;
        setAllEquipment(list);
        setAllEquipmentError(undefined);
      } catch (err) {
        if (live) setAllEquipmentError(err instanceof ApiError ? err.message : 'Could not load equipment.');
      }
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);

  useEffect(() => {
    if (restoringSession || authUser?.role !== 'client') return;
    let live = true;
    (async () => {
      try {
        const list = await apiListMyEquipmentClasses();
        if (!live) return;
        setMyEquipmentClasses(list);
        setMyEquipmentClassesError(undefined);
      } catch (err) {
        if (live) setMyEquipmentClassesError(err instanceof ApiError ? err.message : 'Could not load equipment classes.');
      }
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);

  const refreshMyDevices = async () => {
    try {
      setMyDevices(await apiListMyDevices());
      setMyDevicesError(undefined);
    } catch (err) {
      setMyDevicesError(err instanceof ApiError ? err.message : 'Could not load devices.');
    }
  };

  useEffect(() => {
    if (restoringSession || authUser?.role !== 'client') return;
    let live = true;
    (async () => {
      try {
        const list = await apiListMyDevices();
        if (!live) return;
        setMyDevices(list);
        setMyDevicesError(undefined);
      } catch (err) {
        if (live) setMyDevicesError(err instanceof ApiError ? err.message : 'Could not load devices.');
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

  const refreshCausalChains = async () => {
    try {
      setCausalChains(await apiListAuthoringCausalChains());
      setCausalChainsError(undefined);
    } catch (err) {
      setCausalChainsError(err instanceof ApiError ? err.message : 'Could not load causal chains.');
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

      try {
        const chains = await apiListAuthoringCausalChains();
        if (!live) return;
        setCausalChains(chains);
        setCausalChainsError(undefined);
      } catch (err) {
        if (live) setCausalChainsError(err instanceof ApiError ? err.message : 'Could not load causal chains.');
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

  const refreshPlatformStaff = async () => {
    try {
      setPlatformStaff(await apiListPlatformStaff());
      setPlatformStaffError(undefined);
    } catch (err) {
      setPlatformStaffError(err instanceof ApiError ? err.message : 'Could not load staff.');
    }
  };

  useEffect(() => {
    if (restoringSession || authUser?.role !== 'master-admin') return;
    let live = true;
    (async () => {
      try {
        const list = await apiListPlatformStaff();
        if (!live) return;
        setPlatformStaff(list);
        setPlatformStaffError(undefined);
      } catch (err) {
        if (live) setPlatformStaffError(err instanceof ApiError ? err.message : 'Could not load staff.');
      }
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);

  const refreshSensorCatalog = async (includeRetired = showRetiredSensors) => {
    try {
      const [cats, list] = await Promise.all([
        apiListSensorCategories(includeRetired),
        apiListSensors(includeRetired),
      ]);
      setSensorCategories(cats);
      setRealSensors(list);
      setSensorsError(undefined);
    } catch (err) {
      setSensorsError(err instanceof ApiError ? err.message : 'Could not load sensors.');
    }
  };

  const handleToggleShowRetiredSensors = (next: boolean) => {
    setShowRetiredSensors(next);
    refreshSensorCatalog(next);
  };

  const refreshToolMappings = async () => {
    try {
      setRealToolMappings(await apiListToolMappings());
      setToolMappingsError(undefined);
    } catch (err) {
      setToolMappingsError(err instanceof ApiError ? err.message : 'Could not load tool mappings.');
    }
  };

  // The unmatched list rides along: it changes whenever a type is created, renamed or
  // re-matched, and the tab shows both together.
  const refreshIndustryTypes = async () => {
    try {
      const [types, unmatched] = await Promise.all([apiListIndustryTypes(), apiListUnmatchedIndustries()]);
      setIndustryTypes(types);
      setUnmatchedIndustries(unmatched);
      setIndustryTypesError(undefined);
    } catch (err) {
      setIndustryTypesError(err instanceof ApiError ? err.message : 'Could not load industry types.');
    }
  };

  const refreshSignalAliases = async () => {
    try {
      setSignalAliases(await apiListSignalAliases());
      setSignalAliasesError(undefined);
    } catch (err) {
      setSignalAliasesError(err instanceof ApiError ? err.message : 'Could not load signal aliases.');
    }
  };

  const refreshSignalStates = async () => {
    try {
      setSignalStates(await apiListSignalStates());
      setSignalStatesError(undefined);
    } catch (err) {
      setSignalStatesError(err instanceof ApiError ? err.message : 'Could not load signal states.');
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

  // Every list below is fetched once at sign-in, so a tab showed whatever was true
  // then until the next sign-in, however long ago that was (TC_134). Opening an admin
  // page or tab now fetches that page's lists again. Per role, because each role can
  // read only its own: a master-admin list asked for by a client is a 403, not data.
  useEffect(() => {
    if (restoringSession || !authUser) return;
    const master = authUser.role === 'master-admin';
    const path = location.pathname;
    const sub = path.startsWith('/admin/') ? path.split('/')[2] : path.split('/')[1];
    const forMaster: Record<string, (() => Promise<void>)[]> = {
      industry: [refreshIndustryTypes],
      sensor: [() => refreshSensorCatalog()],
      category: [refreshEquipmentClasses, refreshScenarios, refreshAlertTemplates, refreshCausalChains],
      'tool-mapping': [refreshToolMappings, refreshIndustryTypes, () => refreshSensorCatalog()],
      'signal-alias': [refreshSignalAliases],
      'signal-state': [refreshSignalStates],
      'named-formula': [refreshNamedFormulas],
      'catalog-import': [refreshCatalogImports, refreshEquipmentClasses],
      clients: [refreshAccounts, refreshEntitlements, refreshEquipmentClasses],
      staff: [refreshPlatformStaff],
      devices: [refreshDevicePool, refreshAccounts, refreshToolMappings],
      equipment: [refreshAllEquipment, refreshAccounts],
    };
    const forClient: Record<string, (() => Promise<void>)[]> = {
      plant: [refreshPlants],
      devices: [refreshMyDevices, refreshEquipment],
      equipment: [refreshEquipment, refreshMyDevices, refreshPlants],
      'client-users': [refreshTenantUsers, refreshRoles, refreshPlants],
      roles: [refreshRoles],
    };
    // Each refresher records its own failure on its own screen; none may stop another.
    void Promise.allSettled(((master ? forMaster : forClient)[sub] ?? []).map((refresh) => refresh()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, restoringSession, authUser?.role]);

  // Sensors and their categories — reference data both roles read
  // (`device-catalog.read`, granted to every tenant role). Tool mappings and the
  // device pool stay master-admin only below — clients have no capability for either.
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

      try {
        const [types, unmatched] = await Promise.all([apiListIndustryTypes(), apiListUnmatchedIndustries()]);
        if (live) { setIndustryTypes(types); setUnmatchedIndustries(unmatched); setIndustryTypesError(undefined); }
      } catch (err) {
        if (live) setIndustryTypesError(err instanceof ApiError ? err.message : 'Could not load industry types.');
      }

      try {
        const aliases = await apiListSignalAliases();
        if (live) { setSignalAliases(aliases); setSignalAliasesError(undefined); }
      } catch (err) {
        if (live) setSignalAliasesError(err instanceof ApiError ? err.message : 'Could not load signal aliases.');
      }

      try {
        const vocab = await apiListSignalStates();
        if (live) { setSignalStates(vocab); setSignalStatesError(undefined); }
      } catch (err) {
        if (live) setSignalStatesError(err instanceof ApiError ? err.message : 'Could not load signal states.');
      }
    })();
    return () => { live = false; };
  }, [authUser, restoringSession]);



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
        const reason = window.prompt(i18n.t('prompts.suspendReason', { name: current.clientName }));
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

  // Only a suspended account nobody ever signed in to, holding no data — the
  // backend refuses anything else and says why.
  const handleDeleteAccount = async (tenantId: string) => {
    await apiDeleteAccount(tenantId);
    await refreshAccounts();
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

  const handleSetUserAccess = async (userId: string, input: SetUserAccessInput) => {
    const updated = await apiSetUserAccess(userId, input);
    await refreshTenantUsers();
    return updated;
  };

  const handleSuspendUser = async (userId: string, reason: string) => {
    const updated = await apiSuspendUser(userId, reason);
    await refreshTenantUsers();
    return updated;
  };

  const handleDeleteUser = async (userId: string) => {
    await apiDeleteUser(userId);
    await refreshTenantUsers();
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
  const handleRetireSensorCategory = async (id: string) => {
    const retired = await apiRetireSensorCategory(id);
    await refreshSensorCatalog();
    return retired;
  };
  const handleUnretireSensorCategory = async (id: string) => {
    const restored = await apiUnretireSensorCategory(id);
    await refreshSensorCatalog();
    return restored;
  };
  const handleRenameSensorCategory = async (id: string, name: string) => {
    const renamed = await apiRenameSensorCategory(id, name);
    await refreshSensorCatalog();
    return renamed;
  };
  const handleDeleteSensorCategory = async (id: string) => {
    await apiDeleteSensorCategory(id);
    await refreshSensorCatalog();
  };
  const handleRetireSensor = async (id: string) => {
    const retired = await apiRetireSensor(id);
    await refreshSensorCatalog();
    return retired;
  };
  const handleUnretireSensor = async (id: string) => {
    const restored = await apiUnretireSensor(id);
    await refreshSensorCatalog();
    return restored;
  };
  const handleDeleteSensor = async (id: string) => {
    await apiDeleteSensor(id);
    await refreshSensorCatalog();
  };
  const handleCreateToolMapping = async (input: ToolMappingInput) => {
    const created = await apiCreateToolMapping(input);
    await refreshToolMappings();
    return created;
  };
  const handleDeleteToolMapping = async (id: string) => {
    await apiDeleteToolMapping(id);
    await refreshToolMappings();
  };
  const handleUpdateToolMapping = async (id: string, input: ToolMappingInput) => {
    const updated = await apiUpdateToolMapping(id, input);
    await refreshToolMappings();
    return updated;
  };
  const handleUpsertSignalAlias = async (input: SignalAliasInput) => {
    const saved = await apiUpsertSignalAlias(input);
    await refreshSignalAliases();
    return saved;
  };
  const handleDeleteSignalAlias = async (sourceSystem: string, alias: string) => {
    await apiDeleteSignalAlias(sourceSystem, alias);
    await refreshSignalAliases();
  };
  const handleReplaceSignalStates = async (role: string, states: SignalStateCode[]) => {
    const saved = await apiReplaceSignalStates(role, states);
    await refreshSignalStates();
    return saved;
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

  // Release/retire need a reason — the API requires one and audits it — same
  // browser-prompt stand-in handleToggleClientStatus already uses for account
  // suspension, until this screen gets a proper dialog.
  const reportBadOutcome = (results: { imei: string; outcome: string }[]) => {
    const bad = results.filter((r) => r.outcome !== 'assigned');
    if (bad.length) {
      setDevicePoolError(bad.map((r) => `${r.imei}: ${r.outcome}`).join('; '));
    } else {
      setDevicePoolError(undefined);
    }
  };

  const handleReleaseDevice = async (imei: string) => {
    const reason = window.prompt(i18n.t('prompts.takeBackReason', { imei }));
    if (!reason) return;
    try {
      reportBadOutcome(await apiReleaseDevices([imei], reason));
    } catch (err) {
      setDevicePoolError(err instanceof ApiError ? err.message : 'Could not release the device.');
    }
    await refreshDevicePool();
  };

  const handleRetireDevice = async (imei: string) => {
    const reason = window.prompt(i18n.t('prompts.retireReason', { imei }));
    if (!reason) return;
    try {
      reportBadOutcome(await apiRetireDevices([imei], reason));
    } catch (err) {
      setDevicePoolError(err instanceof ApiError ? err.message : 'Could not retire the device.');
    }
    await refreshDevicePool();
  };

  // Rethrows, unlike the movements above: the edit modal shows the refusal (a tool
  // profile change on a device that has left stock) next to the field.
  const handleUpdateDevice = async (imei: string, input: Parameters<typeof apiUpdateDevice>[1]) => {
    await apiUpdateDevice(imei, input);
    await refreshDevicePool();
  };

  const handleReturnDeviceToStock = async (imei: string) => {
    try {
      reportBadOutcome(await apiReturnDevicesToStock([imei]));
    } catch (err) {
      setDevicePoolError(err instanceof ApiError ? err.message : 'Could not return the device to stock.');
    }
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

  const handleUnretireEquipmentClass = async (slug: string) => {
    try {
      await apiUnretireEquipmentClass(slug);
      await refreshEquipmentClasses();
    } catch (err) {
      setEquipmentClassesError(err instanceof ApiError ? err.message : 'Could not un-retire.');
    }
  };

  const handleCreateNamedFormula = async (slug: string, input: NamedFormulaInput) => {
    const created = await apiCreateNamedFormula(slug, input);
    await refreshNamedFormulas();
    return created;
  };

  const handleUpdateNamedFormula = async (slug: string, version: number, input: NamedFormulaInput) => {
    const updated = await apiEditNamedFormula(slug, version, input);
    await refreshNamedFormulas();
    return updated;
  };

  // Rethrows: the reason a formula cannot publish (a dimension mismatch, an
  // undeclared role) is shown on that formula's own card, not in a banner the
  // person may have scrolled past.
  const handlePublishNamedFormula = async (slug: string, version: number) => {
    await apiPublishNamedFormula(slug, version);
    await refreshNamedFormulas();
  };

  // The commercial boundary (entitlement.service.ts) — a tenant cannot grant
  // itself a class, so this exists only on the master-admin side.
  const handleGrantEntitlement = async (tenantId: string, equipmentClassSlug: string, note?: string) => {
    const grant = await apiGrantEntitlement(tenantId, equipmentClassSlug, note);
    await refreshEntitlements();
    return grant;
  };

  const handleRevokeEntitlement = async (id: string) => {
    const revoked = await apiRevokeEntitlement(id);
    await refreshEntitlements();
    return revoked;
  };

  // `input.tenantId`/an explicit `tenantId` arg means Master Admin acting on another
  // account (see EquipmentInput and apiMoveEquipment/apiRetireEquipment) — refreshes
  // the cross-tenant list instead of the caller's own, which stays empty for them.
  const handleImportEquipmentFromMirror = async (sourceSystem: string) => {
    const result = await apiImportEquipmentFromMirror(sourceSystem);
    await refreshEquipment();
    return result;
  };

  const handleCreateEquipmentProfile = async (input: EquipmentInput) => {
    const created = await apiCreateEquipment(input);
    await (input.tenantId ? refreshAllEquipment() : refreshEquipment());
    return created;
  };

  const handleUpdateEquipmentProfile = async (
    sourceSystem: string, externalId: string, input: Partial<Omit<EquipmentInput, 'code' | 'plantId'>>,
  ) => {
    const updated = await apiUpdateEquipment(sourceSystem, externalId, input);
    await (input.tenantId ? refreshAllEquipment() : refreshEquipment());
    return updated;
  };

  const handleMoveEquipmentProfile = async (
    sourceSystem: string, externalId: string, toPlantId: string | null, reason: string, tenantId?: string,
  ) => {
    const moved = await apiMoveEquipment(sourceSystem, externalId, toPlantId, reason, tenantId);
    await (tenantId ? refreshAllEquipment() : refreshEquipment());
    return moved;
  };

  const handleGetEquipmentPlacementHistory = (sourceSystem: string, externalId: string, tenantId?: string) =>
    apiGetEquipmentPlacementHistory(sourceSystem, externalId, tenantId);

  const handleRetireEquipmentProfile = async (
    sourceSystem: string, externalId: string, reason: string, tenantId?: string,
  ) => {
    const retired = await apiRetireEquipment(sourceSystem, externalId, reason, tenantId);
    await (tenantId ? refreshAllEquipment() : refreshEquipment());
    return retired;
  };

  const handleListPlantsForTenant = (tenantId: string) => apiListPlants(true, tenantId);

  const handleClaimDevice = async (imei: string, equipmentExternalId: string, sourceSystem: string) => {
    const claimed = await apiClaimDevice(imei, equipmentExternalId, sourceSystem);
    await refreshMyDevices();
    return claimed;
  };

  const handleUnclaimDevice = async (imei: string, reason?: string) => {
    const unclaimed = await apiUnclaimDevice(imei, reason);
    await refreshMyDevices();
    return unclaimed;
  };

  // Per-equipment, fetched on demand by the Signal Bindings panel — not lifted
  // state, the same way nothing else in this file caches one machine's detail.
  const handleGetEquipmentCoverage = (sourceSystem: string, externalId: string): Promise<CoverageResult> =>
    apiGetEquipmentCoverage(sourceSystem, externalId);

  const handleGetBindingDiscovery = (sourceSystem: string, externalId: string): Promise<DiscoveryResult> =>
    apiGetBindingDiscovery(sourceSystem, externalId);

  const handleProposeOrActivateBinding = (
    sourceSystem: string, externalId: string, input: ProposeOrActivateBindingInput,
  ): Promise<SignalBindingVersion> =>
    apiProposeOrActivateBinding(sourceSystem, externalId, input);

  // Same on-demand shape as the bindings handlers above — fetched by the Signal
  // Bindings modal's new Scenarios/KPIs sections, not lifted state.
  const handleListEquipmentKpis = (sourceSystem: string, externalId: string): Promise<KpiEnvelope[]> =>
    apiListEquipmentKpis(sourceSystem, externalId);

  const handleListMyCatalogScenarios = (equipmentClassSlug?: string): Promise<ClientScenario[]> =>
    apiListMyCatalogScenarios(equipmentClassSlug);

  const handleListActivations = (sourceSystem: string, externalId: string): Promise<ActivationView[]> =>
    apiListActivations({ sourceSystem, externalId });

  const handleActivationTransition = (
    action: ActivationAction,
    input: { sourceSystem: string; externalId: string; clientScenarioSlug: string; reason?: string },
  ): Promise<ActivationView> =>
    apiActivationTransition(action, input);

  const handleGetActivationHistory = (sourceSystem: string, externalId: string) =>
    apiGetActivationHistory(sourceSystem, externalId);

  const handleGetEquipmentRecommendations = (sourceSystem: string, externalId: string) =>
    apiGetEquipmentRecommendations(sourceSystem, externalId);

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

  const handleCreateCausalChain = async (slug: string, input: CausalChainInput) => {
    const created = await apiDraftCausalChain(slug, input);
    await refreshCausalChains();
    return created;
  };

  const handlePublishCausalChain = async (slug: string) => {
    try {
      await apiPublishCausalChain(slug);
      await refreshCausalChains();
    } catch (err) {
      setCausalChainsError(err instanceof ApiError ? err.message : 'Could not publish.');
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

  const handleApplyCatalogImport = async (id: string, acknowledgeWarnings = false) => {
    const summary = await apiApplyCatalogImport(id, acknowledgeWarnings);
    // The workbook can create or version classes, scenarios and alert templates —
    // every screen that already lists those needs to see the result without a reload.
    await Promise.all([
      refreshCatalogImports(), refreshEquipmentClasses(), refreshScenarios(), refreshAlertTemplates(),
    ]);
    return summary;
  };

  const handleDiscardCatalogImport = async (id: string) => {
    await apiDiscardCatalogImport(id);
    await refreshCatalogImports();
  };

  const handleReviewCatalogImportSensors = (id: string, selection: SensorReviewSelection) =>
    apiReviewCatalogImportSensors(id, selection);

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

  const handleInviteStaff = async (input: {
    email: string; fullName: string; role: PlatformStaffRole,
  }): Promise<InvitePlatformStaffResult> => {
    const result = await apiInvitePlatformStaff(input);
    await refreshPlatformStaff();
    return result;
  };

  const handleSetStaffRole = async (id: string, role: PlatformStaffRole) => {
    await apiSetPlatformStaffRole(id, role);
    await refreshPlatformStaff();
  };

  const handleSuspendStaff = async (id: string, reason: string) => {
    await apiSuspendPlatformStaff(id, reason);
    await refreshPlatformStaff();
  };

  const handleDeleteStaff = async (id: string) => {
    await apiDeletePlatformStaff(id);
    await refreshPlatformStaff();
  };

  const handleReinstateStaff = async (id: string) => {
    await apiReinstatePlatformStaff(id);
    await refreshPlatformStaff();
  };
  const handleOpenEquipmentClass = (slug: string) => navigate(`/admin/category/${slug}`);

  const handleOpenCatalogImport = () => navigate('/admin/catalog-import');

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

  const handleSetPlantBoundary = async (id: string, boundary: GeoJsonPolygon | null) => {
    const updated = await apiSetPlantBoundary(id, boundary);
    await refreshPlants();
    return updated;
  };
  // Tool mappings are refreshed too: they show the type's name, so a rename or a
  // re-match changes what that table reads.
  const handleCreateIndustryType = async (input: IndustryTypeInput & { name: string; code: string }) => {
    await apiCreateIndustryType(input);
    await refreshIndustryTypes();
  };
  const handleUpdateIndustryType = async (id: string, input: IndustryTypeInput) => {
    await apiUpdateIndustryType(id, input);
    await Promise.all([refreshIndustryTypes(), refreshToolMappings()]);
  };
  const handleDeleteIndustryType = async (id: string) => {
    await apiDeleteIndustryType(id);
    await refreshIndustryTypes();
  };
  const handleRematchIndustries = async () => {
    const result = await apiRematchIndustries();
    await Promise.all([refreshIndustryTypes(), refreshToolMappings()]);
    return result;
  };

  return (
    <Routes>
      <Route element={<GuestOnly />}>
        <Route path="/sign-in" element={<LoginScreen />} />
        <Route path="/forgot-password" element={<ForgotPasswordScreen />} />
        <Route path="/accept-invitation" element={<AcceptInvitationScreen />} />
      </Route>

      <Route element={<RequireAuth />}>
        <Route element={<Shell onSidebarNavigate={() => setManageAccessClientId(null)} />}>
          <Route index element={<Navigate to="/dashboard" replace />} />

          <Route
            path="dashboard"
            element={
              <DashboardPage clients={clients} />
            }
          />
          <Route path="dashboard-live" element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard/:sourceSystem/:externalId" element={<ThingDetailLivePage />} />

          <Route path="admin">
            <Route index element={<AdminIndexRedirect />} />
            <Route
              path="devices/new"
              element={
                <DeviceSetupPage
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
                  onDiscard={handleDiscardCatalogImport}
                  onReviewSensors={handleReviewCatalogImportSensors}
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
                  causalChains={causalChains}
                  causalChainsError={causalChainsError}
                  onCreateCausalChain={handleCreateCausalChain}
                  onPublishCausalChain={handlePublishCausalChain}
                />
              }
            />
            <Route path="equipment/:sourceSystem/:externalId/page" element={<EquipmentPagePage />} />
            <Route path="sites/:plantId/page" element={<SitePagePage />} />
            <Route
              path=":subTab"
              element={
                <AdminPage
                  sensors={sensors}
                  toolMappings={toolMappings}
                  categories={categories}
                  industryTypes={industryTypes}
                  industryTypesError={industryTypesError}
                  unmatchedIndustries={unmatchedIndustries}
                  plants={plants}
                  sensorCategories={sensorCategories}
                  realSensors={realSensors}
                  sensorsError={sensorsError}
                  showRetiredSensors={showRetiredSensors}
                  onToggleShowRetiredSensors={handleToggleShowRetiredSensors}
                  onCreateSensor={handleCreateSensor}
                  onUpdateSensor={handleUpdateSensor}
                  onRetireSensor={handleRetireSensor}
                  onUnretireSensor={handleUnretireSensor}
                  onDeleteSensor={handleDeleteSensor}
                  onCreateSensorCategory={handleCreateSensorCategory}
                  onRetireSensorCategory={handleRetireSensorCategory}
                  onUnretireSensorCategory={handleUnretireSensorCategory}
                  onRenameSensorCategory={handleRenameSensorCategory}
                  onDeleteSensorCategory={handleDeleteSensorCategory}
                  realToolMappings={realToolMappings}
                  toolMappingsError={toolMappingsError}
                  onCreateToolMapping={handleCreateToolMapping}
                  onUpdateToolMapping={handleUpdateToolMapping}
                  onDeleteToolMapping={handleDeleteToolMapping}
                  signalAliases={signalAliases}
                  signalAliasesError={signalAliasesError}
                  onUpsertSignalAlias={handleUpsertSignalAlias}
                  onDeleteSignalAlias={handleDeleteSignalAlias}
                  signalStates={signalStates}
                  signalStatesError={signalStatesError}
                  onReplaceSignalStates={handleReplaceSignalStates}
                  devicePool={devicePool}
                  devicePoolError={devicePoolError}
                  onRegisterDevices={handleRegisterDevices}
                  onAssignDevice={handleAssignDevice}
                  onReleaseDevice={handleReleaseDevice}
                  onRetireDevice={handleRetireDevice}
                  onUpdateDevice={handleUpdateDevice}
                  onReturnDeviceToStock={handleReturnDeviceToStock}
                  equipmentClasses={equipmentClasses}
                  equipmentClassesError={equipmentClassesError}
                  onCreateEquipmentClass={handleCreateEquipmentClass}
                  onUpdateEquipmentClass={handleUpdateEquipmentClass}
                  onPublishEquipmentClass={handlePublishEquipmentClass}
                  onRetireEquipmentClass={handleRetireEquipmentClass}
                  onUnretireEquipmentClass={handleUnretireEquipmentClass}
                  onOpenEquipmentClass={handleOpenEquipmentClass}
                  onOpenCatalogImport={handleOpenCatalogImport}
                  namedFormulas={namedFormulas}
                  namedFormulasError={namedFormulasError}
                  onCreateNamedFormula={handleCreateNamedFormula}
                  onUpdateNamedFormula={handleUpdateNamedFormula}
                  onPublishNamedFormula={handlePublishNamedFormula}
                  onCreateIndustryType={handleCreateIndustryType}
                  onUpdateIndustryType={handleUpdateIndustryType}
                  onDeleteIndustryType={handleDeleteIndustryType}
                  onRematchIndustries={handleRematchIndustries}
                  realPlants={realPlants}
                  plantsError={plantsError}
                  onCreatePlant={handleCreatePlant}
                  onUpdatePlant={handleUpdatePlantReal}
                  onTogglePlantStatus={handleTogglePlantStatus}
                  onSetPlantBoundary={handleSetPlantBoundary}
                  realEquipment={realEquipment}
                  realEquipmentError={realEquipmentError}
                  allEquipment={allEquipment}
                  allEquipmentError={allEquipmentError}
                  onListPlantsForTenant={handleListPlantsForTenant}
                  onCreateEquipment={handleCreateEquipmentProfile}
                  onUpdateEquipment={handleUpdateEquipmentProfile}
                  onMoveEquipment={handleMoveEquipmentProfile}
                  onRetireEquipment={handleRetireEquipmentProfile}
                  onGetEquipmentPlacementHistory={handleGetEquipmentPlacementHistory}
                  myEquipmentClasses={myEquipmentClasses}
                  myEquipmentClassesError={myEquipmentClassesError}
                  myDevices={myDevices}
                  myDevicesError={myDevicesError}
                  onClaimDevice={handleClaimDevice}
                  onUnclaimDevice={handleUnclaimDevice}
                  onGetEquipmentCoverage={handleGetEquipmentCoverage}
                  onGetBindingDiscovery={handleGetBindingDiscovery}
                  onProposeOrActivateBinding={handleProposeOrActivateBinding}
                  onListEquipmentKpis={handleListEquipmentKpis}
                  onListMyCatalogScenarios={handleListMyCatalogScenarios}
                  onListActivations={handleListActivations}
                  onActivationTransition={handleActivationTransition}
                  onGetActivationHistory={handleGetActivationHistory}
                  onGetEquipmentRecommendations={handleGetEquipmentRecommendations}
                  onImportEquipmentFromMirror={handleImportEquipmentFromMirror}
                  clients={clients}
                  accountsError={accountsError}
                  onCreateAccount={handleCreateAccount}
                  onUpdateAccount={handleUpdateAccount}
                  onResendInvitation={handleResendInvitation}
                  onToggleClientStatus={handleToggleClientStatus}
                  onDeleteAccount={handleDeleteAccount}
                  entitlements={entitlements}
                  entitlementsError={entitlementsError}
                  onGrantEntitlement={handleGrantEntitlement}
                  onRevokeEntitlement={handleRevokeEntitlement}
                  staff={platformStaff}
                  staffError={platformStaffError}
                  onInviteStaff={handleInviteStaff}
                  onSetStaffRole={handleSetStaffRole}
                  onSuspendStaff={handleSuspendStaff}
                  onReinstateStaff={handleReinstateStaff}
                  onDeleteStaff={handleDeleteStaff}
                />
              }
            />
          </Route>

          <Route
            path="ai-onboarding"
            element={<AiOnboardingPage />}
          />

          <Route path="things-care" element={<ErrorBoundary fallbackTitle="ThingsCare"><ThingsCarePage /></ErrorBoundary>} />
          <Route path="things-care/:sourceSystem/:externalId" element={<ErrorBoundary fallbackTitle="ThingsCare"><ThingsCareDetailPage /></ErrorBoundary>} />
          <Route path="things-shield" element={<ThingsShieldPage />} />
          <Route path="things-shield/:sourceSystem/:externalId" element={<ThingsShieldDetailPage />} />
          <Route path="incident-management" element={<IncidentManagementPage />} />
          <Route path="production-monitoring" element={<ProductionMonitoringPage />} />
          <Route path="production-monitoring/:sourceSystem/:externalId" element={<ProductionMonitoringDetailPage />} />
          <Route path="alert-agent" element={<AlertAgentPage />} />
          <Route path="drafts" element={<DraftsPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="predictions" element={<ErrorBoundary fallbackTitle="Predictions"><LivePredictionsPage /></ErrorBoundary>} />
          <Route path="scenarios" element={<ErrorBoundary fallbackTitle="Scenarios"><ScenariosPage /></ErrorBoundary>} />
          <Route path="work-orders" element={<WorkOrdersPage />} />
          <Route path="cost-administration" element={<CostAdministrationPage />} />

          {/* The Users hub held Platform Users (the Staff page again) and a mock view of every
              client's users; the mock was removed 2026-10-21, so the address goes to Staff. */}
          <Route path="users" element={<Navigate to="/admin/staff" replace />} />

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
                onDeleteUser={handleDeleteUser}
                plants={realPlants}
                equipment={realEquipment}
                onSetUserAccess={handleSetUserAccess}
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
