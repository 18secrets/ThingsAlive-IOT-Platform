import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3,
  Disc,
  Gauge,
  MapPinned,
  LayoutGrid,
  Building2,
  Wrench,
  Cpu,
  Briefcase,
  ShieldCheck,
  FunctionSquare,
  Fuel,
  AlertOctagon,
  ChevronLeft,
  ChevronRight,
  ChevronDown
} from 'lucide-react';
import { AdminSubTab, CLIENT_ADMIN_SUBTABS, SensorItem, ToolMappingItem, CategoryItem, PlantItem, ClientAccount } from '../../types';
import {
  Account, CreateAccountResult, EquipmentClass, EquipmentClassInput, Plant, PlantInput, ResendInvitationResult,
  Sensor, SensorCategory, SensorInput, ToolMapping, ToolMappingInput, PooledDevice, RegisterDeviceInput,
  InvitePlatformStaffResult, PlatformStaffMember, PlatformStaffRole,
  Entitlement, EquipmentProfile, EquipmentInput, EquipmentPlacementEvent,
  MyDevice, CoverageResult, DiscoveryResult, ProposeOrActivateBindingInput, SignalBindingVersion,
  KpiEnvelope, ClientScenario, ActivationView, ActivationAction, ActivationHistoryEvent, EquipmentRecommendation,
  NamedFormula, NamedFormulaInput, SignalAlias, SignalAliasInput, GeoJsonPolygon, ImportResult,
  SignalStateVocabEntry, SignalStateCode, IndustryType, IndustryTypeInput, UnmatchedIndustry, ClassOption
} from '../../lib/api';
import { SensorTable } from './SensorTable';
import { ToolMappingTable } from './ToolMappingTable';
import { SignalAliasTable } from './SignalAliasTable';
import { SignalStateTable } from './SignalStateTable';
import { CategoryView } from './CategoryView';
import { NamedFormulaView } from './NamedFormulaView';
import { IndustryTypeView, PlantView } from './OtherAdminViews';
import { TelemetryArchiveView } from './TelemetryArchiveView';
import { FaultCodeLibraryView } from './FaultCodeLibraryView';
import { ClientDeviceManagement } from '../devices/ClientDeviceManagement';
import { DevicePoolManagement } from '../devices/DevicePoolManagement';
import { EquipmentManagement } from '../equipment/EquipmentManagement';
import { MasterEquipmentManagement } from '../equipment/MasterEquipmentManagement';
import { ClientManagement } from '../clients/ClientManagement';
import { StaffManagement } from '../staff/StaffManagement';
import { FuelForecastAccuracyPage } from '../../pages/FuelForecastAccuracyPage';
import { ModelsTab } from '../models/ModelsView';
import { ServiceRosterView } from '../service-roster/ServiceRosterView';

interface AdminManagementProps {
  sensors: SensorItem[];
  toolMappings: ToolMappingItem[];
  categories: CategoryItem[];
  /** Real industry types (GET /device-catalog/industry-types) — Master Admin only. */
  industryTypes: IndustryType[];
  industryTypesError?: string;
  unmatchedIndustries: UnmatchedIndustry[];
  plants: PlantItem[];
  /** The real reference sensors/categories/tool mappings — Master Admin only.
   *  Separate from the mock `sensors`/`toolMappings` above, which still feed
   *  Equipment's still-mock pickers. */
  sensorCategories: SensorCategory[];
  realSensors: Sensor[];
  sensorsError?: string;
  showRetiredSensors: boolean;
  onToggleShowRetiredSensors: (next: boolean) => void;
  onCreateSensor: (input: SensorInput) => Promise<Sensor>;
  onUpdateSensor: (id: string, input: SensorInput) => Promise<Sensor>;
  onRetireSensor: (id: string) => Promise<Sensor>;
  onUnretireSensor: (id: string) => Promise<Sensor>;
  onDeleteSensor: (id: string) => Promise<void>;
  onCreateSensorCategory: (name: string) => Promise<SensorCategory>;
  onRetireSensorCategory: (id: string) => Promise<SensorCategory>;
  onUnretireSensorCategory: (id: string) => Promise<SensorCategory>;
  onRenameSensorCategory: (id: string, name: string) => Promise<SensorCategory>;
  onDeleteSensorCategory: (id: string) => Promise<void>;
  realToolMappings: ToolMapping[];
  toolMappingsError?: string;
  onCreateToolMapping: (input: ToolMappingInput) => Promise<ToolMapping>;
  onUpdateToolMapping: (id: string, input: ToolMappingInput) => Promise<ToolMapping>;
  onDeleteToolMapping: (id: string) => Promise<void>;
  signalAliases: SignalAlias[];
  signalAliasesError?: string;
  onUpsertSignalAlias: (input: SignalAliasInput) => Promise<SignalAlias>;
  onDeleteSignalAlias: (sourceSystem: string, alias: string) => Promise<void>;
  signalStates: SignalStateVocabEntry[];
  signalStatesError?: string;
  onReplaceSignalStates: (role: string, states: SignalStateCode[]) => Promise<SignalStateVocabEntry[]>;
  /** The real device pool (GET /inventory/pool) — Master Admin only. Separate
   *  from the mock `devices` below, which still feeds Equipment's picker and
   *  the client's own still-mock Devices tab. */
  devicePool: PooledDevice[];
  devicePoolError?: string;
  /** True until the pool's first answer: the list is unknown then, not empty. */
  devicePoolLoading?: boolean;
  onRegisterDevices: (devices: RegisterDeviceInput[]) => Promise<{ registered: number; alreadyKnown: number }>;
  onAssignDevice: (imei: string, tenantId: string) => Promise<void>;
  onReleaseDevice: (imei: string) => Promise<void>;
  onRetireDevice: (imei: string) => Promise<void>;
  onUpdateDevice: (imei: string, input: { model?: string | null; toolMappingId?: string | null; batchRef?: string | null; notes?: string | null }) => Promise<void>;
  onReturnDeviceToStock: (imei: string) => Promise<void>;
  /** The real catalog — platform-owned template classes, Master Admin only. */
  equipmentClasses: EquipmentClass[];
  equipmentClassesError?: string;
  onCreateEquipmentClass: (slug: string, input: EquipmentClassInput) => Promise<EquipmentClass>;
  onUpdateEquipmentClass: (slug: string, input: EquipmentClassInput) => Promise<EquipmentClass>;
  onPublishEquipmentClass: (slug: string) => Promise<void>;
  onRetireEquipmentClass: (slug: string) => Promise<void>;
  onUnretireEquipmentClass: (slug: string) => Promise<void>;
  onOpenEquipmentClass: (slug: string) => void;
  onOpenCatalogImport: () => void;
  /** Physics shared across classes, Master Admin only. */
  namedFormulas: NamedFormula[];
  namedFormulasError?: string;
  onCreateNamedFormula: (slug: string, input: NamedFormulaInput) => Promise<NamedFormula>;
  onUpdateNamedFormula: (slug: string, version: number, input: NamedFormulaInput) => Promise<NamedFormula>;
  onPublishNamedFormula: (slug: string, version: number) => Promise<void>;
  onSetNamedFormulaActive: (slug: string, active: boolean) => Promise<void>;
  onCreateIndustryType?: (input: IndustryTypeInput & { name: string; code: string }) => Promise<void>;
  onUpdateIndustryType?: (id: string, input: IndustryTypeInput) => Promise<void>;
  onDeleteIndustryType?: (id: string) => Promise<void>;
  onRematchIndustries?: () => Promise<{ matched: number; unmatched: number }>;
  /** The signed-in client's own sites, real (GET /equipment/plants) — client role only. */
  realPlants: Plant[];
  plantsError?: string;
  onCreatePlant: (input: PlantInput) => Promise<Plant>;
  onUpdatePlant: (id: string, input: Partial<PlantInput>) => Promise<Plant>;
  onTogglePlantStatus: (id: string, currentStatus: Plant['status']) => void;
  onSetPlantBoundary: (id: string, boundary: GeoJsonPolygon | null) => Promise<Plant>;
  onImportEquipmentFromMirror: (sourceSystem: string) => Promise<ImportResult>;
  onOpenSitePage: (plantId: string) => void;
  onNavigateToAISetup?: () => void;
  realEquipment: EquipmentProfile[];
  realEquipmentError?: string;
  realEquipmentLoading?: boolean;
  /** Every account's register in one read (`GET /equipment/all`) — Master Admin's
   *  own Equipment sidebar page. Separate from `realEquipment`, which is
   *  tenant-scoped and empty for them. */
  allEquipment: EquipmentProfile[];
  allEquipmentError?: string;
  /** True until the first answer: the list is unknown then, not empty. */
  allEquipmentLoading?: boolean;
  onCreateEquipment: (input: EquipmentInput) => Promise<EquipmentProfile>;
  onUpdateEquipment: (
    sourceSystem: string, externalId: string, input: Partial<Omit<EquipmentInput, 'code' | 'plantId'>>,
  ) => Promise<EquipmentProfile>;
  // `tenantId` is Master Admin's own override — optional because the client-scoped
  // EquipmentManagement below never passes one.
  onMoveEquipment: (
    sourceSystem: string, externalId: string, toPlantId: string | null, reason: string, tenantId?: string,
  ) => Promise<EquipmentProfile>;
  onRetireEquipment: (
    sourceSystem: string, externalId: string, reason: string, tenantId?: string,
  ) => Promise<EquipmentProfile>;
  onGetEquipmentPlacementHistory: (
    sourceSystem: string, externalId: string, tenantId?: string,
  ) => Promise<EquipmentPlacementEvent[]>;
  onListPlantsForTenant: (tenantId: string) => Promise<Plant[]>;
  myEquipmentClasses: ClassOption[];
  myEquipmentClassesError?: string;
  myDevices: MyDevice[];
  myDevicesError?: string;
  myDevicesLoading?: boolean;
  onClaimDevice: (imei: string, equipmentExternalId: string, sourceSystem: string) => Promise<MyDevice>;
  onUnclaimDevice: (imei: string, reason?: string) => Promise<MyDevice>;
  onGetEquipmentCoverage: (sourceSystem: string, externalId: string) => Promise<CoverageResult>;
  onGetBindingDiscovery: (sourceSystem: string, externalId: string) => Promise<DiscoveryResult>;
  onProposeOrActivateBinding: (
    sourceSystem: string, externalId: string, input: ProposeOrActivateBindingInput,
  ) => Promise<SignalBindingVersion>;
  onListEquipmentKpis: (sourceSystem: string, externalId: string) => Promise<KpiEnvelope[]>;
  onListMyCatalogScenarios: (equipmentClassSlug?: string) => Promise<ClientScenario[]>;
  onListActivations: (sourceSystem: string, externalId: string) => Promise<ActivationView[]>;
  onActivationTransition: (
    action: ActivationAction,
    input: { sourceSystem: string; externalId: string; clientScenarioSlug: string; reason?: string },
  ) => Promise<ActivationView>;
  onGetActivationHistory: (sourceSystem: string, externalId: string) => Promise<ActivationHistoryEvent[]>;
  onGetEquipmentRecommendations: (
    sourceSystem: string, externalId: string,
  ) => Promise<{ equipmentClassSlug: string | null; recommendations: EquipmentRecommendation[] }>;
  activeSubTab: AdminSubTab;
  onChangeSubTab: (tab: AdminSubTab) => void;
  clients: ClientAccount[];
  accountsError?: string;
  onCreateAccount: (
    input: { tenantId: string; name: string; email: string; fullName: string; phone?: string },
  ) => Promise<CreateAccountResult>;
  onUpdateAccount: (
    tenantId: string,
    input: { name: string; email: string; fullName: string; phone?: string },
  ) => Promise<Account>;
  onResendInvitation: (tenantId: string) => Promise<ResendInvitationResult>;
  onToggleClientStatus: (id: string) => void;
  onDeleteAccount: (id: string) => Promise<void>;
  entitlements: Entitlement[];
  entitlementsError?: string;
  onGrantEntitlement: (tenantId: string, equipmentClassSlug: string, note?: string) => Promise<Entitlement>;
  onRevokeEntitlement: (id: string) => Promise<Entitlement>;
  staff: PlatformStaffMember[];
  staffError?: string;
  onInviteStaff: (input: {
    email: string; fullName: string; role: PlatformStaffRole;
  }) => Promise<InvitePlatformStaffResult>;
  onSetStaffRole: (id: string, role: PlatformStaffRole) => Promise<void>;
  onSuspendStaff: (id: string, reason: string) => Promise<void>;
  onReinstateStaff: (id: string) => Promise<void>;
  onDeleteStaff: (id: string) => Promise<void>;
  /** True for a client-role user — restricts the subtab bar to Plant/Devices/Equipment only. */
  restrictToClientAdmin?: boolean;
  /** Which sub-tabs this person may open (lib/pageAccess.ts); absent = all. */
  canOpenSubTab?: (tab: AdminSubTab) => boolean;
}

// Fuel forecast accuracy (D53) is a reading of the account's own fleet, beside the fleet
// it reads; Administration is where an account's people already go to see that fleet.
// Models: the account's own copies, which its machines name for their ratings (D57).
// Service roster (Crompton U5): which engineer a job on each site goes to.
// Each is granted to a role on its own (types.ts, CLIENT_ADMIN_SUBTABS).
const CLIENT_VISIBLE_ADMIN_SUBTABS: readonly AdminSubTab[] = CLIENT_ADMIN_SUBTABS;

// Master Admin only (task: move to the sidebar, 2026-10-10) — see Shell.tsx's
// ADMIN_PROMOTED_SUBTABS, which this must match. Still rendered by this same
// component at the same /admin/<subtab> routes; only the sub-tab bar and the
// sidebar highlighting changed.
const PROMOTED_SUBTABS: AdminSubTab[] = ['clients', 'staff', 'devices', 'equipment', 'fault-codes'];

export const AdminManagement: React.FC<AdminManagementProps> = ({
  sensors,
  toolMappings,
  categories,
  industryTypes,
  industryTypesError,
  unmatchedIndustries,
  plants,
  sensorCategories,
  realSensors,
  sensorsError,
  showRetiredSensors,
  onToggleShowRetiredSensors,
  onCreateSensor,
  onUpdateSensor,
  onRetireSensor,
  onUnretireSensor,
  onDeleteSensor,
  onCreateSensorCategory,
  onRetireSensorCategory,
  onUnretireSensorCategory,
  onRenameSensorCategory,
  onDeleteSensorCategory,
  realToolMappings,
  toolMappingsError,
  onCreateToolMapping,
  onUpdateToolMapping,
  onDeleteToolMapping,
  signalAliases,
  signalAliasesError,
  onUpsertSignalAlias,
  onDeleteSignalAlias,
  signalStates,
  signalStatesError,
  onReplaceSignalStates,
  devicePool,
  onReleaseDevice,
  onRetireDevice,
  onUpdateDevice,
  onReturnDeviceToStock,
  devicePoolError,
  devicePoolLoading,
  onRegisterDevices,
  onAssignDevice,
  equipmentClasses,
  equipmentClassesError,
  onCreateEquipmentClass,
  onUpdateEquipmentClass,
  onPublishEquipmentClass,
  onRetireEquipmentClass,
  onUnretireEquipmentClass,
  onOpenEquipmentClass,
  onOpenCatalogImport,
  namedFormulas,
  namedFormulasError,
  onCreateNamedFormula,
  onUpdateNamedFormula,
  onPublishNamedFormula,
  onSetNamedFormulaActive,
  onCreateIndustryType,
  onUpdateIndustryType,
  onDeleteIndustryType,
  onRematchIndustries,
  realPlants,
  plantsError,
  onCreatePlant,
  onUpdatePlant,
  onTogglePlantStatus,
  onSetPlantBoundary,
  onImportEquipmentFromMirror,
  onOpenSitePage,
  onNavigateToAISetup,
  realEquipment,
  realEquipmentError,
  realEquipmentLoading,
  allEquipment,
  allEquipmentError,
  allEquipmentLoading,
  onListPlantsForTenant,
  onCreateEquipment,
  onUpdateEquipment,
  onMoveEquipment,
  onGetEquipmentPlacementHistory,
  onRetireEquipment,
  myEquipmentClasses,
  myEquipmentClassesError,
  myDevices,
  myDevicesError,
  myDevicesLoading,
  onClaimDevice,
  onUnclaimDevice,
  onGetEquipmentCoverage,
  onGetBindingDiscovery,
  onProposeOrActivateBinding,
  onListEquipmentKpis,
  onListMyCatalogScenarios,
  onListActivations,
  onActivationTransition,
  onGetActivationHistory,
  onGetEquipmentRecommendations,
  activeSubTab,
  onChangeSubTab,
  clients,
  accountsError,
  onCreateAccount,
  onUpdateAccount,
  onResendInvitation,
  onToggleClientStatus,
  onDeleteAccount,
  entitlements,
  entitlementsError,
  onGrantEntitlement,
  onRevokeEntitlement,
  staff,
  staffError,
  onInviteStaff,
  onSetStaffRole,
  onSuspendStaff,
  onReinstateStaff,
  onDeleteStaff,
  restrictToClientAdmin,
  canOpenSubTab,
}) => {
  const { t } = useTranslation('admin');
  const allSubTabs: { id: AdminSubTab; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'industry', label: t('tabs.industryType'), icon: BarChart3 },
    { id: 'clients', label: t('translation:sidebar.clients'), icon: Briefcase },
    { id: 'staff', label: t('translation:sidebar.staff'), icon: ShieldCheck },
    { id: 'plant', label: t('tabs.plant'), icon: Building2 },
    { id: 'category', label: t('tabs.equipmentClasses'), icon: LayoutGrid },
    { id: 'named-formula', label: t('tabs.namedFormulas'), icon: FunctionSquare },
    { id: 'model', label: t('tabs.models'), icon: Gauge },
    { id: 'service-roster', label: t('tabs.serviceRoster'), icon: MapPinned },
    { id: 'sensor', label: t('tabs.sensor'), icon: Disc },
    { id: 'tool-mapping', label: t('tabs.toolMapping'), icon: Wrench },
    { id: 'signal-alias', label: t('tabs.signalAliases'), icon: Disc },
    { id: 'signal-state', label: t('tabs.signalStates'), icon: Disc },
    { id: 'devices', label: t('translation:sidebar.devices'), icon: Cpu },
    { id: 'equipment', label: t('translation:sidebar.equipment'), icon: Wrench },
    { id: 'fault-codes', label: t('tabs.faultCodes'), icon: AlertOctagon },
    { id: 'telemetry-archive', label: t('tabs.telemetryArchive'), icon: Disc },
    { id: 'fuel-forecast-accuracy', label: t('tabs.fuelForecastAccuracy'), icon: Fuel },
  ];

  // Master Admin's tab bar: no Plant (tenant-scoped, no cross-tenant read —
  // the same reason "Manage Access" doesn't exist for them either, see
  // ClientManagement). Clients/Staff/Devices/Equipment moved out of this bar
  // entirely (2026-10-10) — they're promoted to their own sidebar entries
  // (see Shell.tsx's ADMIN_PROMOTED_SUBTABS) because the bar had grown too
  // crowded; PROMOTED_SUBTABS below is what's left of that filter. A client's
  // own Devices/Equipment are untouched by this — CLIENT_VISIBLE_ADMIN_SUBTABS
  // is a separate list that still names them.
  const subTabs = restrictToClientAdmin
    ? allSubTabs.filter((tab) => CLIENT_VISIBLE_ADMIN_SUBTABS.includes(tab.id) && (canOpenSubTab?.(tab.id) ?? true))
    : allSubTabs.filter((tab) => (
      !['plant', ...PROMOTED_SUBTABS].includes(tab.id) && (canOpenSubTab?.(tab.id) ?? true)
    ));

  // A promoted tab (Master Admin only) is reached directly from the sidebar
  // now, not from this bar — showing the bar above it would offer tabs that
  // visually imply it's still nested under Administration, which it no
  // longer is.
  const isPromotedTab = !restrictToClientAdmin && PROMOTED_SUBTABS.includes(activeSubTab);

  return (
    <div id="admin-module" className="space-y-3">

      {/* Admin Navigation Sub-Tabs */}
      {!isPromotedTab && <AdminTabBar tabs={subTabs} active={activeSubTab} onChange={onChangeSubTab} />}

      {/* Sub-tab Views */}
      <div>

        {!restrictToClientAdmin && activeSubTab === 'sensor' && (
          <SensorTable
            sensors={realSensors}
            error={sensorsError}
            categories={sensorCategories}
            showRetired={showRetiredSensors}
            onToggleShowRetired={onToggleShowRetiredSensors}
            onCreateSensor={onCreateSensor}
            onUpdateSensor={onUpdateSensor}
            onRetireSensor={onRetireSensor}
            onUnretireSensor={onUnretireSensor}
            onDeleteSensor={onDeleteSensor}
            onCreateCategory={onCreateSensorCategory}
            onRetireCategory={onRetireSensorCategory}
            onUnretireCategory={onUnretireSensorCategory}
            onRenameCategory={onRenameSensorCategory}
            onDeleteCategory={onDeleteSensorCategory}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'tool-mapping' && (
          <ToolMappingTable
            mappings={realToolMappings}
            error={toolMappingsError}
            onCreateMapping={onCreateToolMapping}
            onUpdateMapping={onUpdateToolMapping}
            onDeleteMapping={onDeleteToolMapping}
            availableSensors={realSensors}
            industryTypes={industryTypes}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'signal-alias' && (
          <SignalAliasTable
            aliases={signalAliases}
            error={signalAliasesError}
            onUpsertAlias={onUpsertSignalAlias}
            onDeleteAlias={onDeleteSignalAlias}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'fault-codes' && <FaultCodeLibraryView clients={clients} />}

        {!restrictToClientAdmin && activeSubTab === 'telemetry-archive' && (
          <TelemetryArchiveView clientName={(id) => clients.find((c) => c.id === id)?.clientName ?? id} />
        )}

        {!restrictToClientAdmin && activeSubTab === 'signal-state' && (
          <SignalStateTable
            states={signalStates}
            error={signalStatesError}
            onReplaceStates={onReplaceSignalStates}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'category' && (
          <CategoryView
            classes={equipmentClasses}
            error={equipmentClassesError}
            onCreateClass={onCreateEquipmentClass}
            onUpdateClass={onUpdateEquipmentClass}
            onPublishClass={onPublishEquipmentClass}
            onRetireClass={onRetireEquipmentClass}
            onUnretireClass={onUnretireEquipmentClass}
            onOpenClass={onOpenEquipmentClass}
            onOpenBulkImport={onOpenCatalogImport}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'named-formula' && (
          <NamedFormulaView
            formulas={namedFormulas}
            error={namedFormulasError}
            onCreateFormula={onCreateNamedFormula}
            onUpdateFormula={onUpdateNamedFormula}
            onPublishFormula={onPublishNamedFormula}
            onSetFormulaActive={onSetNamedFormulaActive}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'industry' && (
          <IndustryTypeView
            items={industryTypes}
            error={industryTypesError}
            unmatched={unmatchedIndustries}
            onCreateIndustryType={onCreateIndustryType}
            onUpdateIndustryType={onUpdateIndustryType}
            onDeleteIndustryType={onDeleteIndustryType}
            onRematchIndustries={onRematchIndustries}
          />
        )}

        {restrictToClientAdmin && activeSubTab === 'fuel-forecast-accuracy' && <FuelForecastAccuracyPage />}

        {activeSubTab === 'model' && <ModelsTab scope={restrictToClientAdmin ? 'account' : 'library'} />}

        {restrictToClientAdmin && activeSubTab === 'service-roster' && <ServiceRosterView />}

        {restrictToClientAdmin && activeSubTab === 'plant' && (
          <PlantView
            plants={realPlants}
            error={plantsError}
            onCreatePlant={onCreatePlant}
            onUpdatePlant={onUpdatePlant}
            onToggleStatus={onTogglePlantStatus}
            onOpenSitePage={onOpenSitePage}
            onSetPlantBoundary={onSetPlantBoundary}
          />
        )}

        {restrictToClientAdmin && activeSubTab === 'devices' && (
          <ClientDeviceManagement
            devices={myDevices}
            error={myDevicesError}
            loading={myDevicesLoading}
            equipment={realEquipment}
            onUnclaimDevice={onUnclaimDevice}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'devices' && (
          <DevicePoolManagement
            pool={devicePool}
            error={devicePoolError}
            loading={devicePoolLoading}
            clients={clients}
            toolMappings={realToolMappings}
            onRegister={onRegisterDevices}
            onAssign={onAssignDevice}
            onRelease={onReleaseDevice}
            onRetire={onRetireDevice}
            onUpdate={onUpdateDevice}
            onReturnToStock={onReturnDeviceToStock}
          />
        )}

        {restrictToClientAdmin && activeSubTab === 'equipment' && (
          <EquipmentManagement
            equipment={realEquipment}
            error={realEquipmentError}
            loading={realEquipmentLoading}
            onCreateEquipment={onCreateEquipment}
            onUpdateEquipment={onUpdateEquipment}
            onMoveEquipment={onMoveEquipment}
            onGetEquipmentPlacementHistory={onGetEquipmentPlacementHistory}
            onRetireEquipment={onRetireEquipment}
            equipmentClasses={myEquipmentClasses}
            equipmentClassesError={myEquipmentClassesError}
            plants={realPlants}
            devices={myDevices}
            devicesError={myDevicesError}
            onClaimDevice={onClaimDevice}
            onUnclaimDevice={onUnclaimDevice}
            onGetCoverage={onGetEquipmentCoverage}
            onGetDiscovery={onGetBindingDiscovery}
            onProposeOrActivateBinding={onProposeOrActivateBinding}
            onListEquipmentKpis={onListEquipmentKpis}
            onListMyCatalogScenarios={onListMyCatalogScenarios}
            onListActivations={onListActivations}
            onActivationTransition={onActivationTransition}
            onGetActivationHistory={onGetActivationHistory}
            onGetEquipmentRecommendations={onGetEquipmentRecommendations}
            onImportEquipmentFromMirror={onImportEquipmentFromMirror}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'equipment' && (
          <MasterEquipmentManagement
            equipment={allEquipment}
            error={allEquipmentError}
            loading={allEquipmentLoading}
            clients={clients}
            onCreateEquipment={onCreateEquipment}
            onUpdateEquipment={onUpdateEquipment}
            onMoveEquipment={onMoveEquipment}
            onRetireEquipment={onRetireEquipment}
            onGetEquipmentPlacementHistory={onGetEquipmentPlacementHistory}
            onListPlantsForTenant={onListPlantsForTenant}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'clients' && (
          <ClientManagement
            clients={clients}
            error={accountsError}
            onCreateAccount={onCreateAccount}
            onUpdateAccount={onUpdateAccount}
            onResendInvitation={onResendInvitation}
            onToggleStatus={onToggleClientStatus}
            onDeleteAccount={onDeleteAccount}
            equipmentClasses={equipmentClasses}
            entitlements={entitlements}
            entitlementsError={entitlementsError}
            onGrantEntitlement={onGrantEntitlement}
            onRevokeEntitlement={onRevokeEntitlement}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'staff' && (
          <StaffManagement
            staff={staff}
            error={staffError}
            onInvite={onInviteStaff}
            onSetRole={onSetStaffRole}
            onSuspend={onSuspendStaff}
            onReinstate={onReinstateStaff}
            onDelete={onDeleteStaff}
          />
        )}
      </div>

    </div>
  );
};

type TabDef = { id: AdminSubTab; label: string; icon: React.FC<{ className?: string }> };

/**
 * The sub-tab bar (17 Nov). Eleven bordered buttons ran off the right edge with nothing
 * saying there were more ("Signal Ali…"), and on a phone one and a half showed. Now one
 * slim bar of underlined tabs, as Fault Codes' own; when they do not all fit, the edges
 * fade and arrows scroll it, and the open tab is always scrolled into view. On a phone
 * a single dropdown names the open section instead: eleven tabs do not scroll usefully
 * at 390 px.
 */
const AdminTabBar: React.FC<{ tabs: TabDef[]; active: AdminSubTab; onChange: (tab: AdminSubTab) => void }> = ({ tabs, active, onChange }) => {
  const { t } = useTranslation('admin');
  const rail = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = () => {
    const el = rail.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(() => {
    measure();
    const el = rail.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tabs.length]);
  // Centred, not just brought into view: at the edge the open tab sat under the arrow.
  useEffect(() => {
    const el = rail.current;
    const tab = el?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    if (el && tab) el.scrollLeft = tab.offsetLeft - (el.clientWidth - tab.offsetWidth) / 2;
    measure();
  }, [active]);
  const scroll = (dir: 1 | -1) => rail.current?.scrollBy({ left: dir * rail.current.clientWidth * 0.7, behavior: 'smooth' });

  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  const CurrentIcon = current?.icon;
  const arrow = 'absolute top-1/2 -translate-y-1/2 z-10 w-7 h-7 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm flex items-center justify-center text-slate-600 dark:text-slate-300 hover:text-[#0B7285] dark:hover:text-sky-400 cursor-pointer';

  return (
    <>
      <div className="sm:hidden relative">
        {CurrentIcon && <CurrentIcon className="w-4 h-4 text-[#0B7285] dark:text-sky-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />}
        <select
          id="admin-subtab-select"
          aria-label={t('tabs.section')}
          value={current?.id}
          onChange={(e) => onChange(e.target.value as AdminSubTab)}
          className="w-full appearance-none rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs pl-9 pr-9 py-2.5 text-sm font-semibold text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#0B7285]/30"
        >
          {tabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
        </select>
        <ChevronDown className="w-4 h-4 text-slate-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>

      <div className="hidden sm:block relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs">
        {edges.left && (
          <>
            <div className="pointer-events-none absolute inset-y-0 left-0 w-16 rounded-l-xl bg-gradient-to-r from-white dark:from-slate-900 to-transparent z-[5]" />
            <button type="button" onClick={() => scroll(-1)} aria-label={t('tabs.scrollBack')} className={`${arrow} left-2`}><ChevronLeft className="w-4 h-4" /></button>
          </>
        )}
        <div ref={rail} onScroll={measure} role="tablist" className="flex items-stretch gap-1 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = active === tab.id;
            return (
              <button
                key={tab.id}
                id={`admin-subtab-${tab.id}`}
                data-tab={tab.id}
                role="tab"
                aria-selected={isActive}
                onClick={() => onChange(tab.id)}
                className={`relative shrink-0 flex items-center gap-2 px-3 py-3 text-sm whitespace-nowrap transition-colors cursor-pointer ${
                  isActive
                    ? 'text-[#0B7285] dark:text-sky-400 font-semibold'
                    : 'text-slate-600 dark:text-slate-400 font-medium hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
                <span className={`absolute left-2 right-2 bottom-0 h-0.5 rounded-full ${isActive ? 'bg-[#0B7285] dark:bg-sky-400' : 'bg-transparent'}`} />
              </button>
            );
          })}
        </div>
        {edges.right && (
          <>
            <div className="pointer-events-none absolute inset-y-0 right-0 w-16 rounded-r-xl bg-gradient-to-l from-white dark:from-slate-900 to-transparent z-[5]" />
            <button type="button" onClick={() => scroll(1)} aria-label={t('tabs.scrollMore')} className={`${arrow} right-2`}><ChevronRight className="w-4 h-4" /></button>
          </>
        )}
      </div>
    </>
  );
};
