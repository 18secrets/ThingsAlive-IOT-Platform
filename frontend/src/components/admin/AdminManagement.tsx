import React, { useState } from 'react';
import {
  BarChart3,
  Disc,
  LayoutGrid,
  Building2,
  Wrench,
  Cpu,
  Briefcase
} from 'lucide-react';
import { AdminSubTab, SensorItem, ToolMappingItem, CategoryItem, IndustryTypeItem, PlantItem, EquipmentItem, DeviceItem, ClientAccount } from '../../types';
import {
  Account, CreateAccountResult, EquipmentClass, EquipmentClassInput, Plant, PlantInput, ResendInvitationResult,
  Sensor, SensorCategory, SensorInput, ToolMapping, ToolMappingInput, PooledDevice,
  EquipmentTemplate, EquipmentTemplateInput,
} from '../../lib/api';
import { SensorTable } from './SensorTable';
import { ToolMappingTable } from './ToolMappingTable';
import { CategoryView } from './CategoryView';
import { EquipmentTemplateView } from './EquipmentTemplateView';
import { IndustryTypeView, PlantView } from './OtherAdminViews';
import { DeviceManagement } from '../devices/DeviceManagement';
import { DevicePoolManagement } from '../devices/DevicePoolManagement';
import { EquipmentManagement } from '../equipment/EquipmentManagement';
import { ClientManagement } from '../clients/ClientManagement';

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
  onCreateSensor: (input: SensorInput) => Promise<Sensor>;
  onUpdateSensor: (id: string, input: SensorInput) => Promise<Sensor>;
  onCreateSensorCategory: (name: string) => Promise<SensorCategory>;
  realToolMappings: ToolMapping[];
  toolMappingsError?: string;
  onCreateToolMapping: (input: ToolMappingInput) => Promise<ToolMapping>;
  onUpdateToolMapping: (id: string, input: ToolMappingInput) => Promise<ToolMapping>;
  /** The real device pool (GET /inventory/pool) — Master Admin only. Separate
   *  from the mock `devices` below, which still feeds Equipment's picker and
   *  the client's own still-mock Devices tab. */
  devicePool: PooledDevice[];
  devicePoolError?: string;
  onNavigateToRegisterDevice: () => void;
  onAssignDevice: (imei: string, tenantId: string) => Promise<void>;
  /** The real catalog — platform-owned template classes, Master Admin only. */
  equipmentClasses: EquipmentClass[];
  equipmentClassesError?: string;
  onCreateEquipmentClass: (slug: string, input: EquipmentClassInput) => Promise<EquipmentClass>;
  onUpdateEquipmentClass: (slug: string, input: EquipmentClassInput) => Promise<EquipmentClass>;
  onPublishEquipmentClass: (slug: string) => Promise<void>;
  onRetireEquipmentClass: (slug: string) => Promise<void>;
  /** Common onboarding fields, Master Admin only — deliberately separate from
   *  the prediction catalog above; see EquipmentTemplate's own comment. */
  equipmentTemplates: EquipmentTemplate[];
  equipmentTemplatesError?: string;
  onCreateEquipmentTemplate: (input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onUpdateEquipmentTemplate: (id: string, input: EquipmentTemplateInput) => Promise<EquipmentTemplate>;
  onAddIndustryType?: (industryType: IndustryTypeItem) => void;
  onUpdateIndustryType?: (industryType: IndustryTypeItem) => void;
  onDeleteIndustryType?: (id: string) => void;
  /** The signed-in client's own sites, real (GET /equipment/plants) — client role only. */
  realPlants: Plant[];
  plantsError?: string;
  onCreatePlant: (input: PlantInput) => Promise<Plant>;
  onUpdatePlant: (id: string, input: Partial<PlantInput>) => Promise<Plant>;
  onTogglePlantStatus: (id: string, currentStatus: Plant['status']) => void;
  devices: DeviceItem[];
  onNavigateToDeviceSetup: () => void;
  onNavigateToAISetup?: () => void;
  onDeleteDevice: (id: number) => void;
  equipmentList: EquipmentItem[];
  onAddEquipment: (equipment: EquipmentItem) => void;
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
  /** True for a client-role user — restricts the subtab bar to Plant/Devices/Equipment only. */
  restrictToClientAdmin?: boolean;
}

const CLIENT_VISIBLE_ADMIN_SUBTABS: AdminSubTab[] = ['plant', 'devices', 'equipment'];

export const AdminManagement: React.FC<AdminManagementProps> = ({
  sensors,
  toolMappings,
  categories,
  industryTypes,
  plants,
  sensorCategories,
  realSensors,
  sensorsError,
  onCreateSensor,
  onUpdateSensor,
  onCreateSensorCategory,
  realToolMappings,
  toolMappingsError,
  onCreateToolMapping,
  onUpdateToolMapping,
  devicePool,
  devicePoolError,
  onNavigateToRegisterDevice,
  onAssignDevice,
  equipmentClasses,
  equipmentClassesError,
  onCreateEquipmentClass,
  onUpdateEquipmentClass,
  onPublishEquipmentClass,
  onRetireEquipmentClass,
  equipmentTemplates,
  equipmentTemplatesError,
  onCreateEquipmentTemplate,
  onUpdateEquipmentTemplate,
  onAddIndustryType,
  onUpdateIndustryType,
  onDeleteIndustryType,
  realPlants,
  plantsError,
  onCreatePlant,
  onUpdatePlant,
  onTogglePlantStatus,
  devices,
  onNavigateToDeviceSetup,
  onNavigateToAISetup,
  onDeleteDevice,
  equipmentList,
  onAddEquipment,
  activeSubTab,
  onChangeSubTab,
  clients,
  accountsError,
  onCreateAccount,
  onUpdateAccount,
  onResendInvitation,
  onToggleClientStatus,
  restrictToClientAdmin,
}) => {
  const allSubTabs: { id: AdminSubTab; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'industry', label: 'Industry Type', icon: BarChart3 },
    { id: 'clients', label: 'Clients', icon: Briefcase },
    { id: 'plant', label: 'Plant', icon: Building2 },
    { id: 'category', label: 'Equipment Classes', icon: LayoutGrid },
    { id: 'sensor', label: 'Sensor', icon: Disc },
    { id: 'tool-mapping', label: 'Tool Mapping', icon: Wrench },
    { id: 'devices', label: 'Devices', icon: Cpu },
    { id: 'equipment', label: 'Equipment', icon: Wrench },
    { id: 'equipment-template', label: 'Equipment Templates', icon: LayoutGrid },
  ];

  // Master Admin's tab bar: no Plant (tenant-scoped, no cross-tenant read — the
  // same reason "Manage Access" doesn't exist for them either, see
  // ClientManagement), and no Equipment Classes, Equipment, or Industry Type tab
  // (the last hidden for now, by request).
  const subTabs = restrictToClientAdmin
    ? allSubTabs.filter((tab) => CLIENT_VISIBLE_ADMIN_SUBTABS.includes(tab.id))
    : allSubTabs.filter((tab) => !['plant', 'category', 'equipment', 'industry'].includes(tab.id));

  return (
    <div id="admin-module" className="space-y-5">
      
      {/* Admin Navigation Sub-Tabs */}
      <div className="flex items-center gap-2.5 overflow-x-auto pb-1">
        {subTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeSubTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`admin-subtab-${tab.id}`}
              onClick={() => onChangeSubTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium rounded-lg border transition-all flex items-center gap-2 cursor-pointer shrink-0 ${
                isActive
                  ? 'bg-sky-100 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-700 shadow-xs font-semibold'
                  : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-sky-600 dark:text-sky-400' : 'text-slate-500 dark:text-slate-400'}`} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Sub-tab Views */}
      <div className="pt-1">

        {!restrictToClientAdmin && activeSubTab === 'sensor' && (
          <SensorTable
            sensors={realSensors}
            error={sensorsError}
            categories={sensorCategories}
            onCreateSensor={onCreateSensor}
            onUpdateSensor={onUpdateSensor}
            onCreateCategory={onCreateSensorCategory}
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

        {!restrictToClientAdmin && activeSubTab === 'category' && (
          <CategoryView
            classes={equipmentClasses}
            error={equipmentClassesError}
            onCreateClass={onCreateEquipmentClass}
            onUpdateClass={onUpdateEquipmentClass}
            onPublishClass={onPublishEquipmentClass}
            onRetireClass={onRetireEquipmentClass}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'equipment-template' && (
          <EquipmentTemplateView
            templates={equipmentTemplates}
            error={equipmentTemplatesError}
            onCreateTemplate={onCreateEquipmentTemplate}
            onUpdateTemplate={onUpdateEquipmentTemplate}
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
          />
        )}

        {restrictToClientAdmin && activeSubTab === 'devices' && (
          <DeviceManagement
            devices={devices}
            onNavigateToSetup={onNavigateToDeviceSetup}
            onNavigateToAISetup={onNavigateToAISetup}
            onDeleteDevice={onDeleteDevice}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'devices' && (
          <DevicePoolManagement
            pool={devicePool}
            error={devicePoolError}
            clients={clients}
            onNavigateToRegister={onNavigateToRegisterDevice}
            onAssign={onAssignDevice}
          />
        )}

        {restrictToClientAdmin && activeSubTab === 'equipment' && (
          <EquipmentManagement
            equipmentList={equipmentList}
            onAddEquipment={onAddEquipment}
            categories={categories}
            plants={plants}
            toolMappings={toolMappings}
            sensors={sensors}
            clients={clients}
            devices={devices}
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
          />
        )}
      </div>

    </div>
  );
};
