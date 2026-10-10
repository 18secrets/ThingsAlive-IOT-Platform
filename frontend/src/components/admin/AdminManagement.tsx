import React, { useState } from 'react';
import {
  BarChart3,
  Disc,
  LayoutGrid,
  Building2,
  Wrench,
  Cpu,
  Briefcase,
  ShieldCheck,
  FunctionSquare
} from 'lucide-react';
import { AdminSubTab, SensorItem, ToolMappingItem, CategoryItem, IndustryTypeItem, PlantItem, ClientAccount } from '../../types';
import {
  Account, CreateAccountResult, EquipmentClass, EquipmentClassInput, Plant, PlantInput, ResendInvitationResult,
  Sensor, SensorCategory, SensorInput, ToolMapping, ToolMappingInput, PooledDevice, RegisterDeviceInput,
  EquipmentTemplate, EquipmentTemplateInput,
  InvitePlatformStaffResult, PlatformStaffMember, PlatformStaffRole,
  Entitlement, EquipmentProfile, EquipmentInput, EquipmentPlacementEvent,
  MyDevice, CoverageResult, DiscoveryResult, ProposeOrActivateBindingInput, SignalBindingVersion,
  KpiEnvelope, ClientScenario, ActivationView, ActivationAction, ActivationHistoryEvent, EquipmentRecommendation,
  NamedFormula, NamedFormulaInput, SignalAlias, SignalAliasInput, GeoJsonPolygon, ImportResult,
  SignalStateVocabEntry, SignalStateCode,
} from '../../lib/api';
import { SensorTable } from './SensorTable';
import { ToolMappingTable } from './ToolMappingTable';
import { SignalAliasTable } from './SignalAliasTable';
import { SignalStateTable } from './SignalStateTable';
import { CategoryView } from './CategoryView';
import { NamedFormulaView } from './NamedFormulaView';
import { EquipmentTemplateView } from './EquipmentTemplateView';
import { IndustryTypeView, PlantView } from './OtherAdminViews';
import { ClientDeviceManagement } from '../devices/ClientDeviceManagement';
import { DevicePoolManagement } from '../devices/DevicePoolManagement';
import { EquipmentManagement } from '../equipment/EquipmentManagement';
import { MasterEquipmentManagement } from '../equipment/MasterEquipmentManagement';
import { ClientManagement } from '../clients/ClientManagement';
import { StaffManagement } from '../staff/StaffManagement';

interface AdminManagementProps {
  sensors: SensorItem[];
  toolMappings: ToolMappingItem[];
  categories: CategoryItem[];
  industryTypes: IndustryTypeItem[];
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
  onDeleteSensorCategory: (id: string) => Promise<void>;
  realToolMappings: ToolMapping[];
  toolMappingsError?: string;
  onCreateToolMapping: (input: ToolMappingInput) => Promise<ToolMapping>;
  onUpdateToolMapping: (id: string, input: ToolMappingInput) => Promise<ToolMapping>;
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
  onRegisterDevices: (devices: RegisterDeviceInput[]) => Promise<{ registered: number; alreadyKnown: number }>;
  onAssignDevice: (imei: string, tenantId: string) => Promise<void>;
  onReleaseDevice: (imei: string) => Promise<void>;
  onRetireDevice: (imei: string) => Promise<void>;
  onReturnDeviceToStock: (imei: string) => Promise<void>;
  /** The real catalog — platform-owned template classes, Master Admin only. */
  equipmentClasses: EquipmentClass[];
  equipmentClassesError?: string;
  onCreateEquipmentClass: (slug: string, input: EquipmentClassInput) => Promise<EquipmentClass>;
  onUpdateEquipmentClass: (slug: string, input: EquipmentClassInput) => Promise<EquipmentClass>;
  onPublishEquipmentClass: (slug: string) => Promise<void>;
  onRetireEquipmentClass: (slug: string) => Promise<void>;
  onOpenEquipmentClass: (slug: string) => void;
  onOpenCatalogImport: () => void;
  /** Physics shared across classes, Master Admin only. */
  namedFormulas: NamedFormula[];
  namedFormulasError?: string;
  onCreateNamedFormula: (slug: string, input: NamedFormulaInput) => Promise<NamedFormula>;
  onUpdateNamedFormula: (slug: string, version: number, input: NamedFormulaInput) => Promise<NamedFormula>;
  onPublishNamedFormula: (slug: string, version: number) => Promise<void>;
  /** Common onboarding fields, Master Admin only — deliberately separate from
   *  the prediction catalog above; see EquipmentTemplate's own comment. */
  equipmentTemplates: EquipmentTemplate[];
  equipmentTemplatesError?: string;
  onCreateEquipmentTemplate: (input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onUpdateEquipmentTemplate: (id: string, input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onOpenEquipmentTemplate: (templateId: string) => void;
  templateSensorCounts: Record<string, number>;
  templateAlertCounts: Record<string, number>;
  templateKpiCounts: Record<string, number>;
  /** This client's own templates — client role only, invisible to Master Admin
   *  and every other client. See ClientEquipmentTemplateView's own comment. */
  myEquipmentTemplates: EquipmentTemplate[];
  myEquipmentTemplatesError?: string;
  onCreateMyEquipmentTemplate: (input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onUpdateMyEquipmentTemplate: (id: string, input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onOpenMyEquipmentTemplate: (templateId: string) => void;
  myTemplateSensorCounts: Record<string, number>;
  myTemplateAlertCounts: Record<string, number>;
  myTemplateKpiCounts: Record<string, number>;
  onAddIndustryType?: (industryType: IndustryTypeItem) => void;
  onUpdateIndustryType?: (industryType: IndustryTypeItem) => void;
  onDeleteIndustryType?: (id: string) => void;
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
  /** Every account's register in one read (`GET /equipment/all`) — Master Admin's
   *  own Equipment sidebar page. Separate from `realEquipment`, which is
   *  tenant-scoped and empty for them. */
  allEquipment: EquipmentProfile[];
  allEquipmentError?: string;
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
  myEquipmentClasses: EquipmentClass[];
  myEquipmentClassesError?: string;
  myDevices: MyDevice[];
  myDevicesError?: string;
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
  /** True for a client-role user — restricts the subtab bar to Plant/Devices/Equipment only. */
  restrictToClientAdmin?: boolean;
}

const CLIENT_VISIBLE_ADMIN_SUBTABS: AdminSubTab[] = ['plant', 'devices', 'equipment'];

// Master Admin only (task: move to the sidebar, 2026-10-10) — see Shell.tsx's
// ADMIN_PROMOTED_SUBTABS, which this must match. Still rendered by this same
// component at the same /admin/<subtab> routes; only the sub-tab bar and the
// sidebar highlighting changed.
const PROMOTED_SUBTABS: AdminSubTab[] = ['clients', 'staff', 'devices', 'equipment'];

export const AdminManagement: React.FC<AdminManagementProps> = ({
  sensors,
  toolMappings,
  categories,
  industryTypes,
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
  onDeleteSensorCategory,
  realToolMappings,
  toolMappingsError,
  onCreateToolMapping,
  onUpdateToolMapping,
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
  onReturnDeviceToStock,
  devicePoolError,
  onRegisterDevices,
  onAssignDevice,
  equipmentClasses,
  equipmentClassesError,
  onCreateEquipmentClass,
  onUpdateEquipmentClass,
  onPublishEquipmentClass,
  onRetireEquipmentClass,
  onOpenEquipmentClass,
  onOpenCatalogImport,
  namedFormulas,
  namedFormulasError,
  onCreateNamedFormula,
  onUpdateNamedFormula,
  onPublishNamedFormula,
  equipmentTemplates,
  equipmentTemplatesError,
  onCreateEquipmentTemplate,
  onUpdateEquipmentTemplate,
  onOpenEquipmentTemplate,
  templateSensorCounts,
  templateAlertCounts,
  templateKpiCounts,
  myEquipmentTemplates,
  myEquipmentTemplatesError,
  onCreateMyEquipmentTemplate,
  onUpdateMyEquipmentTemplate,
  onOpenMyEquipmentTemplate,
  myTemplateSensorCounts,
  myTemplateAlertCounts,
  myTemplateKpiCounts,
  onAddIndustryType,
  onUpdateIndustryType,
  onDeleteIndustryType,
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
  allEquipment,
  allEquipmentError,
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
  restrictToClientAdmin,
}) => {
  const allSubTabs: { id: AdminSubTab; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'industry', label: 'Industry Type', icon: BarChart3 },
    { id: 'clients', label: 'Clients', icon: Briefcase },
    { id: 'staff', label: 'Staff', icon: ShieldCheck },
    { id: 'plant', label: 'Plant', icon: Building2 },
    { id: 'category', label: 'Equipment Classes', icon: LayoutGrid },
    { id: 'named-formula', label: 'Named Formulas', icon: FunctionSquare },
    { id: 'sensor', label: 'Sensor', icon: Disc },
    { id: 'tool-mapping', label: 'Tool Mapping', icon: Wrench },
    { id: 'signal-alias', label: 'Signal Aliases', icon: Disc },
    { id: 'signal-state', label: 'Signal States', icon: Disc },
    { id: 'devices', label: 'Devices', icon: Cpu },
    { id: 'equipment', label: 'Equipment', icon: Wrench },
    { id: 'equipment-template', label: 'Equipment Templates', icon: LayoutGrid },
  ];

  // Master Admin's tab bar: no Plant (tenant-scoped, no cross-tenant read —
  // the same reason "Manage Access" doesn't exist for them either, see
  // ClientManagement) and no Equipment Templates (client-only "my templates"
  // entry point). Clients/Staff/Devices/Equipment moved out of this bar
  // entirely (2026-10-10) — they're promoted to their own sidebar entries
  // (see Shell.tsx's ADMIN_PROMOTED_SUBTABS) because the bar had grown too
  // crowded; PROMOTED_SUBTABS below is what's left of that filter. A client's
  // own Devices/Equipment are untouched by this — CLIENT_VISIBLE_ADMIN_SUBTABS
  // is a separate list that still names them.
  const subTabs = restrictToClientAdmin
    ? allSubTabs.filter((tab) => CLIENT_VISIBLE_ADMIN_SUBTABS.includes(tab.id))
    : allSubTabs.filter((tab) => (
      !['plant', 'equipment-template', ...PROMOTED_SUBTABS].includes(tab.id)
    ));

  // A promoted tab (Master Admin only) is reached directly from the sidebar
  // now, not from this bar — showing the bar above it would offer tabs that
  // visually imply it's still nested under Administration, which it no
  // longer is.
  const isPromotedTab = !restrictToClientAdmin && PROMOTED_SUBTABS.includes(activeSubTab);

  return (
    <div id="admin-module" className="space-y-5">

      {/* Admin Navigation Sub-Tabs */}
      {!isPromotedTab && (
      <div className="flex items-center gap-2.5 overflow-x-auto pb-1">
        {subTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeSubTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`admin-subtab-${tab.id}`}
              onClick={() => onChangeSubTab(tab.id)}
              className={`px-4 py-2 text-base font-medium rounded-lg border transition-all flex items-center gap-2 cursor-pointer shrink-0 ${
                isActive
                  ? 'bg-sky-100 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-700 shadow-xs font-semibold'
                  : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Icon className={`w-4.5 h-4.5 ${isActive ? 'text-sky-600 dark:text-sky-400' : 'text-slate-500 dark:text-slate-400'}`} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
      )}

      {/* Sub-tab Views */}
      <div className="pt-1">

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
            onDeleteCategory={onDeleteSensorCategory}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'tool-mapping' && (
          <ToolMappingTable
            mappings={realToolMappings}
            error={toolMappingsError}
            onCreateMapping={onCreateToolMapping}
            onUpdateMapping={onUpdateToolMapping}
            availableSensors={realSensors}
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
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'equipment-template' && (
          <EquipmentTemplateView
            templates={equipmentTemplates}
            error={equipmentTemplatesError}
            onCreateTemplate={onCreateEquipmentTemplate}
            onUpdateTemplate={onUpdateEquipmentTemplate}
            onOpenTemplate={onOpenEquipmentTemplate}
            sensorCounts={templateSensorCounts}
            alertCounts={templateAlertCounts}
            kpiCounts={templateKpiCounts}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'industry' && (
          <IndustryTypeView
            items={industryTypes}
            onAddIndustryType={onAddIndustryType}
            onUpdateIndustryType={onUpdateIndustryType}
            onDeleteIndustryType={onDeleteIndustryType}
          />
        )}

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
            equipment={realEquipment}
            onUnclaimDevice={onUnclaimDevice}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'devices' && (
          <DevicePoolManagement
            pool={devicePool}
            error={devicePoolError}
            clients={clients}
            toolMappings={realToolMappings}
            onRegister={onRegisterDevices}
            onAssign={onAssignDevice}
            onRelease={onReleaseDevice}
            onRetire={onRetireDevice}
            onReturnToStock={onReturnDeviceToStock}
          />
        )}

        {restrictToClientAdmin && activeSubTab === 'equipment' && (
          <EquipmentManagement
            equipment={realEquipment}
            error={realEquipmentError}
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
          />
        )}
      </div>

    </div>
  );
};
