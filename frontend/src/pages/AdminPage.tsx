import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AdminSubTab, SensorItem, ToolMappingItem, CategoryItem, IndustryTypeItem, PlantItem,
  DeviceItem, ClientAccount,
} from '../types';
import {
  Account, CreateAccountResult, EquipmentClass, EquipmentClassInput, Plant, PlantInput, ResendInvitationResult,
  Sensor, SensorCategory, SensorInput, ToolMapping, ToolMappingInput, PooledDevice,
  EquipmentTemplate, EquipmentTemplateInput,
  InvitePlatformStaffResult, PlatformStaffMember, PlatformStaffRole,
  Entitlement, EquipmentProfile, EquipmentInput,
  MyDevice, CoverageResult, DiscoveryResult, ProposeOrActivateBindingInput, SignalBindingVersion,
  KpiEnvelope, ClientScenario, ActivationView, ActivationAction,
} from '../lib/api';
import { useAuth } from '../lib/AuthProvider';
import { AdminManagement } from '../components/admin/AdminManagement';

interface AdminPageProps {
  sensors: SensorItem[];
  toolMappings: ToolMappingItem[];
  categories: CategoryItem[];
  industryTypes: IndustryTypeItem[];
  plants: PlantItem[];
  sensorCategories: SensorCategory[];
  realSensors: Sensor[];
  sensorsError?: string;
  onCreateSensor: (input: SensorInput) => Promise<Sensor>;
  onUpdateSensor: (id: string, input: SensorInput) => Promise<Sensor>;
  onCreateSensorCategory: (name: string) => Promise<SensorCategory>;
  realToolMappings: ToolMapping[];
  toolMappingsError?: string;
  onCreateToolMapping: (input: ToolMappingInput) => Promise<ToolMapping>;
  onUpdateToolMapping: (id: string, input: ToolMappingInput) => Promise<ToolMapping>;
  devicePool: PooledDevice[];
  devicePoolError?: string;
  onNavigateToRegisterDevice: () => void;
  onAssignDevice: (imei: string, tenantId: string) => Promise<void>;
  equipmentClasses: EquipmentClass[];
  equipmentClassesError?: string;
  onCreateEquipmentClass: (slug: string, input: EquipmentClassInput) => Promise<EquipmentClass>;
  onUpdateEquipmentClass: (slug: string, input: EquipmentClassInput) => Promise<EquipmentClass>;
  onPublishEquipmentClass: (slug: string) => Promise<void>;
  onRetireEquipmentClass: (slug: string) => Promise<void>;
  onOpenEquipmentClass: (slug: string) => void;
  onOpenCatalogImport: () => void;
  equipmentTemplates: EquipmentTemplate[];
  equipmentTemplatesError?: string;
  onCreateEquipmentTemplate: (input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onUpdateEquipmentTemplate: (id: string, input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onOpenEquipmentTemplate: (templateId: string) => void;
  templateSensorCounts: Record<string, number>;
  templateAlertCounts: Record<string, number>;
  templateKpiCounts: Record<string, number>;
  myEquipmentTemplates: EquipmentTemplate[];
  myEquipmentTemplatesError?: string;
  onCreateMyEquipmentTemplate: (input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onUpdateMyEquipmentTemplate: (id: string, input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onOpenMyEquipmentTemplate: (templateId: string) => void;
  myTemplateSensorCounts: Record<string, number>;
  myTemplateAlertCounts: Record<string, number>;
  myTemplateKpiCounts: Record<string, number>;
  onAddIndustryType: (industryType: IndustryTypeItem) => void;
  onUpdateIndustryType: (industryType: IndustryTypeItem) => void;
  onDeleteIndustryType: (id: string) => void;
  realPlants: Plant[];
  plantsError?: string;
  onCreatePlant: (input: PlantInput) => Promise<Plant>;
  onUpdatePlant: (id: string, input: Partial<PlantInput>) => Promise<Plant>;
  onTogglePlantStatus: (id: string, currentStatus: Plant['status']) => void;
  devices: DeviceItem[];
  onDeleteDevice: (id: number) => void;
  realEquipment: EquipmentProfile[];
  realEquipmentError?: string;
  onCreateEquipment: (input: EquipmentInput) => Promise<EquipmentProfile>;
  onUpdateEquipment: (
    sourceSystem: string, externalId: string, input: Partial<Omit<EquipmentInput, 'code' | 'plantId'>>,
  ) => Promise<EquipmentProfile>;
  onMoveEquipment: (
    sourceSystem: string, externalId: string, toPlantId: string | null, reason: string,
  ) => Promise<EquipmentProfile>;
  onRetireEquipment: (sourceSystem: string, externalId: string, reason: string) => Promise<EquipmentProfile>;
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
}

export const AdminPage: React.FC<AdminPageProps> = (props) => {
  const { authUser } = useAuth();
  const navigate = useNavigate();
  const { subTab } = useParams<{ subTab: string }>();
  if (!authUser) return null;

  const restrictToClientAdmin = authUser.role === 'client';
  // 'industry' is hidden from Master Admin's tab bar for now — see
  // AdminIndexRedirect's own comment in App.tsx, which this must match.
  const activeSubTab = (subTab ?? (restrictToClientAdmin ? 'plant' : 'clients')) as AdminSubTab;

  const visiblePlants = restrictToClientAdmin ? props.plants.filter((p) => p.clientId === authUser.clientId) : props.plants;
  const visibleDevices = restrictToClientAdmin ? props.devices.filter((d) => d.clientId === authUser.clientId) : props.devices;
  const modalClients = restrictToClientAdmin ? props.clients.filter((c) => c.id === authUser.clientId) : props.clients;

  return (
    <AdminManagement
      sensors={props.sensors}
      toolMappings={props.toolMappings}
      categories={props.categories}
      industryTypes={props.industryTypes}
      plants={visiblePlants}
      sensorCategories={props.sensorCategories}
      realSensors={props.realSensors}
      sensorsError={props.sensorsError}
      onCreateSensor={props.onCreateSensor}
      onUpdateSensor={props.onUpdateSensor}
      onCreateSensorCategory={props.onCreateSensorCategory}
      realToolMappings={props.realToolMappings}
      toolMappingsError={props.toolMappingsError}
      onCreateToolMapping={props.onCreateToolMapping}
      onUpdateToolMapping={props.onUpdateToolMapping}
      devicePool={props.devicePool}
      devicePoolError={props.devicePoolError}
      onNavigateToRegisterDevice={props.onNavigateToRegisterDevice}
      onAssignDevice={props.onAssignDevice}
      equipmentClasses={props.equipmentClasses}
      equipmentClassesError={props.equipmentClassesError}
      onCreateEquipmentClass={props.onCreateEquipmentClass}
      onUpdateEquipmentClass={props.onUpdateEquipmentClass}
      onPublishEquipmentClass={props.onPublishEquipmentClass}
      onRetireEquipmentClass={props.onRetireEquipmentClass}
      onOpenEquipmentClass={props.onOpenEquipmentClass}
      onOpenCatalogImport={props.onOpenCatalogImport}
      equipmentTemplates={props.equipmentTemplates}
      equipmentTemplatesError={props.equipmentTemplatesError}
      onCreateEquipmentTemplate={props.onCreateEquipmentTemplate}
      onUpdateEquipmentTemplate={props.onUpdateEquipmentTemplate}
      onOpenEquipmentTemplate={props.onOpenEquipmentTemplate}
      templateSensorCounts={props.templateSensorCounts}
      templateAlertCounts={props.templateAlertCounts}
      templateKpiCounts={props.templateKpiCounts}
      myEquipmentTemplates={props.myEquipmentTemplates}
      myEquipmentTemplatesError={props.myEquipmentTemplatesError}
      onCreateMyEquipmentTemplate={props.onCreateMyEquipmentTemplate}
      onUpdateMyEquipmentTemplate={props.onUpdateMyEquipmentTemplate}
      onOpenMyEquipmentTemplate={props.onOpenMyEquipmentTemplate}
      myTemplateSensorCounts={props.myTemplateSensorCounts}
      myTemplateAlertCounts={props.myTemplateAlertCounts}
      myTemplateKpiCounts={props.myTemplateKpiCounts}
      onAddIndustryType={props.onAddIndustryType}
      onUpdateIndustryType={props.onUpdateIndustryType}
      onDeleteIndustryType={props.onDeleteIndustryType}
      realPlants={props.realPlants}
      plantsError={props.plantsError}
      onCreatePlant={props.onCreatePlant}
      onUpdatePlant={props.onUpdatePlant}
      onTogglePlantStatus={props.onTogglePlantStatus}
      devices={visibleDevices}
      onNavigateToDeviceSetup={() => navigate('/admin/devices/new')}
      onNavigateToAISetup={
        authUser.role === 'master-admin' ? undefined : () => navigate('/ai-onboarding?start=chat')
      }
      onDeleteDevice={props.onDeleteDevice}
      realEquipment={props.realEquipment}
      realEquipmentError={props.realEquipmentError}
      onCreateEquipment={props.onCreateEquipment}
      onUpdateEquipment={props.onUpdateEquipment}
      onMoveEquipment={props.onMoveEquipment}
      onRetireEquipment={props.onRetireEquipment}
      myEquipmentClasses={props.myEquipmentClasses}
      myEquipmentClassesError={props.myEquipmentClassesError}
      myDevices={props.myDevices}
      myDevicesError={props.myDevicesError}
      onClaimDevice={props.onClaimDevice}
      onUnclaimDevice={props.onUnclaimDevice}
      onGetEquipmentCoverage={props.onGetEquipmentCoverage}
      onGetBindingDiscovery={props.onGetBindingDiscovery}
      onProposeOrActivateBinding={props.onProposeOrActivateBinding}
      onListEquipmentKpis={props.onListEquipmentKpis}
      onListMyCatalogScenarios={props.onListMyCatalogScenarios}
      onListActivations={props.onListActivations}
      onActivationTransition={props.onActivationTransition}
      activeSubTab={activeSubTab}
      onChangeSubTab={(tab) => navigate(`/admin/${tab}`)}
      clients={modalClients}
      accountsError={props.accountsError}
      onCreateAccount={props.onCreateAccount}
      onUpdateAccount={props.onUpdateAccount}
      onResendInvitation={props.onResendInvitation}
      onToggleClientStatus={props.onToggleClientStatus}
      entitlements={props.entitlements}
      entitlementsError={props.entitlementsError}
      onGrantEntitlement={props.onGrantEntitlement}
      onRevokeEntitlement={props.onRevokeEntitlement}
      staff={props.staff}
      staffError={props.staffError}
      onInviteStaff={props.onInviteStaff}
      onSetStaffRole={props.onSetStaffRole}
      onSuspendStaff={props.onSuspendStaff}
      onReinstateStaff={props.onReinstateStaff}
      restrictToClientAdmin={restrictToClientAdmin}
    />
  );
};
