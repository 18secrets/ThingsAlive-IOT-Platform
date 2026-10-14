import React from 'react';
import { ClientAccount } from '../types';
import { useAuth } from '../lib/AuthProvider';
import { MasterAdminDashboard } from '../components/dashboard/MasterAdminDashboard';
import { EnterpriseCommandCenter } from '../components/dashboard/EnterpriseCommandCenter';
import { DashboardSwitch } from '../components/dashboard/DashboardSwitch';

interface DashboardPageProps {
  clients: ClientAccount[];
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ clients }) => {
  const { authUser } = useAuth();
  if (!authUser) return null;

  if (authUser.role === 'master-admin') {
    return <MasterAdminDashboard clients={clients} />;
  }

  // UI-only mock fleet view (see src/data/fleetMockData.ts). Shown beside the live
  // dashboard (/dashboard-live) until one of the two is chosen.
  return (
    <div className="space-y-3">
      <DashboardSwitch current="classic" />
      <EnterpriseCommandCenter />
    </div>
  );
};
