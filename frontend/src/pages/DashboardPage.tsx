import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ClientAccount, DeviceItem, EquipmentItem, OnboardingSessionItem } from '../types';
import { useAuth } from '../lib/AuthProvider';
import { MasterAdminDashboard } from '../components/dashboard/MasterAdminDashboard';
import { DashboardView } from '../components/views/OtherViews';

interface DashboardPageProps {
  clients: ClientAccount[];
  devices: DeviceItem[];
  equipmentList: EquipmentItem[];
  onboardingSessions: OnboardingSessionItem[];
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  clients, devices, equipmentList, onboardingSessions,
}) => {
  const { authUser } = useAuth();
  const navigate = useNavigate();
  if (!authUser) return null;

  if (authUser.role === 'master-admin') {
    return (
      <MasterAdminDashboard
        clients={clients}
        devices={devices}
        equipmentList={equipmentList}
        onboardingSessions={onboardingSessions}
      />
    );
  }

  const visibleDevices = devices.filter((d) => d.clientId === authUser.clientId);
  const visibleEquipment = equipmentList.filter((e) => e.clientId === authUser.clientId);
  return (
    <DashboardView
      equipment={visibleEquipment}
      devices={visibleDevices}
      onNavigateToDevices={() => navigate('/admin/devices')}
      onNavigateToEquipment={() => navigate('/admin/equipment')}
    />
  );
};
