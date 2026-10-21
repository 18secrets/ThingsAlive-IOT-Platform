import React from 'react';
import { ClientAccount } from '../types';
import { useAuth } from '../lib/AuthProvider';
import { MasterAdminDashboard } from '../components/dashboard/MasterAdminDashboard';
import { LiveDashboardPage } from './LiveDashboardPage';

interface DashboardPageProps {
  clients: ClientAccount[];
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ clients }) => {
  const { authUser } = useAuth();
  if (!authUser) return null;

  if (authUser.role === 'master-admin') {
    return <MasterAdminDashboard clients={clients} />;
  }

  // The live dashboard is the client dashboard; the classic mock one was removed 2026-10-21.
  return <LiveDashboardPage />;
};
