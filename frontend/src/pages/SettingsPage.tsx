import React from 'react';
import { ClientAccount } from '../types';
import { useAuth } from '../lib/AuthProvider';
import { SettingsView } from '../components/settings/SettingsView';

interface SettingsPageProps {
  clients: ClientAccount[];
  onChangePassword: (currentPassword: string, newPassword: string) => string | null;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ clients, onChangePassword }) => {
  const { authUser } = useAuth();
  if (!authUser) return null;
  return <SettingsView authUser={authUser} clients={clients} onChangePassword={onChangePassword} />;
};
