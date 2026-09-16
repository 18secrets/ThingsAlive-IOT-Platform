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
import { AdminSubTab, SensorItem, ToolMappingItem, CategoryItem, IndustryTypeItem, PlantItem, EquipmentItem, DeviceItem, ClientAccount, ClientUserItem, RoleDefinition } from '../../types';
import { SensorTable } from './SensorTable';
import { ToolMappingTable } from './ToolMappingTable';
import { CategoryView } from './CategoryView';
import { IndustryTypeView, PlantView } from './OtherAdminViews';
import { DeviceManagement } from '../devices/DeviceManagement';
import { EquipmentManagement } from '../equipment/EquipmentManagement';
import { ClientManagement } from '../clients/ClientManagement';

interface AdminManagementProps {
  sensors: SensorItem[];
  toolMappings: ToolMappingItem[];
  categories: CategoryItem[];
  industryTypes: IndustryTypeItem[];
  plants: PlantItem[];
  onAddSensor: (sensor: SensorItem) => void;
  onAddToolMapping: (mapping: ToolMappingItem) => void;
  onAddCategory: (category: CategoryItem) => void;
  onUpdateCategory: (category: CategoryItem) => void;
  onDeleteCategory: (id: string) => void;
  onAddIndustryType?: (industryType: IndustryTypeItem) => void;
  onUpdateIndustryType?: (industryType: IndustryTypeItem) => void;
  onDeleteIndustryType?: (id: string) => void;
  onAddPlant?: (plant: PlantItem) => void;
  onUpdatePlant?: (plant: PlantItem) => void;
  onDeletePlant?: (id: string) => void;
  devices: DeviceItem[];
  onNavigateToDeviceSetup: () => void;
  onNavigateToAISetup?: () => void;
  onDeleteDevice: (id: number) => void;
  equipmentList: EquipmentItem[];
  onAddEquipment: (equipment: EquipmentItem) => void;
  activeSubTab: AdminSubTab;
  onChangeSubTab: (tab: AdminSubTab) => void;
  clients: ClientAccount[];
  onAddClient: (client: ClientAccount) => void;
  onUpdateClient: (client: ClientAccount) => void;
  onToggleClientStatus: (id: string) => void;
  onResetClientPassword: (id: string) => void;
  clientUsers: ClientUserItem[];
  roles: RoleDefinition[];
  onManageClientAccess: (clientId: string) => void;
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
  onAddSensor,
  onAddToolMapping,
  onAddCategory,
  onUpdateCategory,
  onDeleteCategory,
  onAddIndustryType,
  onUpdateIndustryType,
  onDeleteIndustryType,
  onAddPlant,
  onUpdatePlant,
  onDeletePlant,
  devices,
  onNavigateToDeviceSetup,
  onNavigateToAISetup,
  onDeleteDevice,
  equipmentList,
  onAddEquipment,
  activeSubTab,
  onChangeSubTab,
  clients,
  onAddClient,
  onUpdateClient,
  onToggleClientStatus,
  onResetClientPassword,
  clientUsers,
  roles,
  onManageClientAccess,
  restrictToClientAdmin,
}) => {
  const allSubTabs: { id: AdminSubTab; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'industry', label: 'Industry Type', icon: BarChart3 },
    { id: 'clients', label: 'Clients', icon: Briefcase },
    { id: 'plant', label: 'Plant', icon: Building2 },
    { id: 'category', label: 'Category', icon: LayoutGrid },
    { id: 'sensor', label: 'Sensor', icon: Disc },
    { id: 'tool-mapping', label: 'Tool Mapping', icon: Wrench },
    { id: 'devices', label: 'Devices', icon: Cpu },
    { id: 'equipment', label: 'Equipment', icon: Wrench },
  ];

  const subTabs = restrictToClientAdmin
    ? allSubTabs.filter((tab) => CLIENT_VISIBLE_ADMIN_SUBTABS.includes(tab.id))
    : allSubTabs;

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
            sensors={sensors}
            onAddSensor={onAddSensor}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'tool-mapping' && (
          <ToolMappingTable
            mappings={toolMappings}
            onAddMapping={onAddToolMapping}
            availableSensors={sensors}
          />
        )}

        {!restrictToClientAdmin && activeSubTab === 'category' && (
          <CategoryView
            categories={categories}
            onAddCategory={onAddCategory}
            onUpdateCategory={onUpdateCategory}
            onDeleteCategory={onDeleteCategory}
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

        {activeSubTab === 'plant' && (
          <PlantView
            items={plants}
            onAddPlant={onAddPlant}
            onUpdatePlant={onUpdatePlant}
            onDeletePlant={onDeletePlant}
            clients={clients}
          />
        )}

        {activeSubTab === 'devices' && (
          <DeviceManagement
            devices={devices}
            onNavigateToSetup={onNavigateToDeviceSetup}
            onNavigateToAISetup={onNavigateToAISetup}
            onDeleteDevice={onDeleteDevice}
          />
        )}

        {activeSubTab === 'equipment' && (
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
            clientUsers={clientUsers}
            roles={roles}
            onAddClient={onAddClient}
            onUpdateClient={onUpdateClient}
            onToggleStatus={onToggleClientStatus}
            onResetPassword={onResetClientPassword}
            onManageAccess={onManageClientAccess}
          />
        )}
      </div>

    </div>
  );
};
