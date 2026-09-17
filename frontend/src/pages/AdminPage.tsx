import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AdminSubTab, SensorItem, ToolMappingItem, CategoryItem, IndustryTypeItem, PlantItem,
  EquipmentItem, DeviceItem, ClientAccount,
} from '../types';
import { Account, CreateAccountResult, ResendInvitationResult } from '../lib/api';
import { useAuth } from '../lib/AuthProvider';
import { AdminManagement } from '../components/admin/AdminManagement';

interface AdminPageProps {
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
  onAddIndustryType: (industryType: IndustryTypeItem) => void;
  onUpdateIndustryType: (industryType: IndustryTypeItem) => void;
  onDeleteIndustryType: (id: string) => void;
  onAddPlant: (plant: PlantItem) => void;
  onUpdatePlant: (plant: PlantItem) => void;
  onDeletePlant: (id: string) => void;
  devices: DeviceItem[];
  onDeleteDevice: (id: number) => void;
  equipmentList: EquipmentItem[];
  onAddEquipment: (equipment: EquipmentItem) => void;
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
}

export const AdminPage: React.FC<AdminPageProps> = (props) => {
  const { authUser } = useAuth();
  const navigate = useNavigate();
  const { subTab } = useParams<{ subTab: string }>();
  if (!authUser) return null;

  const restrictToClientAdmin = authUser.role === 'client';
  const activeSubTab = (subTab ?? (restrictToClientAdmin ? 'plant' : 'industry')) as AdminSubTab;

  const visiblePlants = restrictToClientAdmin ? props.plants.filter((p) => p.clientId === authUser.clientId) : props.plants;
  const visibleDevices = restrictToClientAdmin ? props.devices.filter((d) => d.clientId === authUser.clientId) : props.devices;
  const visibleEquipment = restrictToClientAdmin
    ? props.equipmentList.filter((e) => e.clientId === authUser.clientId)
    : props.equipmentList;
  const modalClients = restrictToClientAdmin ? props.clients.filter((c) => c.id === authUser.clientId) : props.clients;

  return (
    <AdminManagement
      sensors={props.sensors}
      toolMappings={props.toolMappings}
      categories={props.categories}
      industryTypes={props.industryTypes}
      plants={visiblePlants}
      onAddSensor={props.onAddSensor}
      onAddToolMapping={props.onAddToolMapping}
      onAddCategory={props.onAddCategory}
      onUpdateCategory={props.onUpdateCategory}
      onDeleteCategory={props.onDeleteCategory}
      onAddIndustryType={props.onAddIndustryType}
      onUpdateIndustryType={props.onUpdateIndustryType}
      onDeleteIndustryType={props.onDeleteIndustryType}
      onAddPlant={props.onAddPlant}
      onUpdatePlant={props.onUpdatePlant}
      onDeletePlant={props.onDeletePlant}
      devices={visibleDevices}
      onNavigateToDeviceSetup={() => navigate('/admin/devices/new')}
      onNavigateToAISetup={
        authUser.role === 'master-admin' ? undefined : () => navigate('/ai-onboarding?start=chat')
      }
      onDeleteDevice={props.onDeleteDevice}
      equipmentList={visibleEquipment}
      onAddEquipment={props.onAddEquipment}
      activeSubTab={activeSubTab}
      onChangeSubTab={(tab) => navigate(`/admin/${tab}`)}
      clients={modalClients}
      accountsError={props.accountsError}
      onCreateAccount={props.onCreateAccount}
      onUpdateAccount={props.onUpdateAccount}
      onResendInvitation={props.onResendInvitation}
      onToggleClientStatus={props.onToggleClientStatus}
      restrictToClientAdmin={restrictToClientAdmin}
    />
  );
};
