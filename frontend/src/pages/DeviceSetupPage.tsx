import React from 'react';
import { useNavigate } from 'react-router-dom';
import { CategoryItem, ClientAccount, DeviceItem, PlantItem, SensorItem, ToolMappingItem } from '../types';
import { useAuth } from '../lib/AuthProvider';
import { usePageHeader } from '../lib/PageHeaderContext';
import { DeviceSetup } from '../components/devices/DeviceSetup';

interface DeviceSetupPageProps {
  toolMappings: ToolMappingItem[];
  sensors: SensorItem[];
  categories: CategoryItem[];
  plants: PlantItem[];
  clients: ClientAccount[];
  onSaveDevice: (device: DeviceItem) => void;
}

export const DeviceSetupPage: React.FC<DeviceSetupPageProps> = ({
  toolMappings, sensors, categories, plants, clients, onSaveDevice,
}) => {
  const { authUser } = useAuth();
  const navigate = useNavigate();
  usePageHeader({
    title: 'Device Setup',
    subtitle: 'Simplified Setup',
    breadcrumb: 'Device Management',
    onBack: () => navigate('/admin/devices'),
  });
  if (!authUser) return null;

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
