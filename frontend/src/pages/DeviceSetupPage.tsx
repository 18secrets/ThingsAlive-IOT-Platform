import React from 'react';
import { useNavigate } from 'react-router-dom';
import { CategoryItem, ClientAccount, DeviceItem, PlantItem, SensorItem, ToolMappingItem } from '../types';
import { RegisterDeviceInput, ToolMapping } from '../lib/api';
import { useAuth } from '../lib/AuthProvider';
import { usePageHeader } from '../lib/PageHeaderContext';
import { DeviceSetup } from '../components/devices/DeviceSetup';
import { RegisterDevicesForm } from '../components/devices/RegisterDevicesForm';

interface DeviceSetupPageProps {
  toolMappings: ToolMappingItem[];
  sensors: SensorItem[];
  categories: CategoryItem[];
  plants: PlantItem[];
  clients: ClientAccount[];
  onSaveDevice: (device: DeviceItem) => void;
  realToolMappings: ToolMapping[];
  onRegisterDevices: (devices: RegisterDeviceInput[]) => Promise<{ registered: number; alreadyKnown: number }>;
}

export const DeviceSetupPage: React.FC<DeviceSetupPageProps> = ({
  toolMappings, sensors, categories, plants, clients, onSaveDevice, realToolMappings, onRegisterDevices,
}) => {
  const { authUser } = useAuth();
  const navigate = useNavigate();
  usePageHeader({
    title: authUser?.role === 'master-admin' ? 'Register Devices' : 'Device Setup',
    subtitle: authUser?.role === 'master-admin' ? 'Device pool' : 'Simplified Setup',
    breadcrumb: 'Device Management',
    onBack: () => navigate('/admin/devices'),
  });
  if (!authUser) return null;

  // Master Admin registers stock by IMEI and an optional tool mapping — assigning it
  // to a client is a separate act from the pool view. Plant/Equipment placement is
  // the client's own claim step and has no place in this form; see DevicePoolManagement.
  if (authUser.role === 'master-admin') {
    return (
      <RegisterDevicesForm
        onBack={() => navigate('/admin/devices')}
        toolMappings={realToolMappings}
        onRegister={onRegisterDevices}
      />
    );
  }

  const visiblePlants = authUser.role === 'client' ? plants.filter((p) => p.clientId === authUser.clientId) : plants;
  const modalClients = authUser.role === 'client' ? clients.filter((c) => c.id === authUser.clientId) : clients;

  return (
    <DeviceSetup
      onBack={() => navigate('/admin/devices')}
      onSaveDevice={(device) => {
        onSaveDevice(device);
        navigate('/admin/devices');
      }}
      toolMappings={toolMappings}
      sensors={sensors}
      categories={categories}
      plants={visiblePlants}
      clients={modalClients}
    />
  );
};
