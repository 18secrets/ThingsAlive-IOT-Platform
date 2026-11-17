import React from 'react';
import { ClientAccount } from '../types';
import { useAuth } from '../lib/AuthProvider';
import { MasterAdminDashboard } from '../components/dashboard/MasterAdminDashboard';
import { LiveDashboardPage } from './LiveDashboardPage';

interface DashboardPageProps {
  clients: ClientAccount[];
  /** Whether the accounts list has answered; Master Admin's tiles wait for it (FU-8). */
  clientsState?: 'loading' | 'ok' | 'unavailable';
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ clients, clientsState = 'ok' }) => {
  const { authUser } = useAuth();
  if (!authUser) return null;

  if (authUser.role === 'master-admin') {
    return <MasterAdminDashboard clients={clients} clientsState={clientsState} />;
  }

  // The live dashboard is the client dashboard; the classic mock one was removed 2026-10-21.
  return <LiveDashboardPage />;
};
