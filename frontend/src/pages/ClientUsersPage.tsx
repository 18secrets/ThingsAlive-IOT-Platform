import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ClientAccount, ClientUserItem, RoleDefinition } from '../types';
import { useAuth } from '../lib/AuthProvider';
import { ClientUserManagement } from '../components/clients/ClientUserManagement';

interface ClientUsersPageProps {
  clients: ClientAccount[];
  clientUsers: ClientUserItem[];
  roles: RoleDefinition[];
  /** Master Admin's drill-down pick from the Users hub — absent for a client's own view. */
  manageAccessClientId: string | null;
  /** Clears the drill-down and returns to Admin ▸ Clients. */
  onBackToClients: () => void;
  onAddUser: (user: ClientUserItem) => void;
  onUpdateUser: (user: ClientUserItem) => void;
  onDeleteUser: (id: string) => void;
  onToggleUserStatus: (id: string) => void;
  onResetPassword: (id: string) => void;
}

export const ClientUsersPage: React.FC<ClientUsersPageProps> = ({
  clients, clientUsers, roles, manageAccessClientId, onBackToClients,
  onAddUser, onUpdateUser, onDeleteUser, onToggleUserStatus, onResetPassword,
}) => {
  const { authUser } = useAuth();
  const navigate = useNavigate();
  if (!authUser) return null;

  const scopeClientId = authUser.role === 'client' ? authUser.clientId : (manageAccessClientId ?? undefined);
  const scopeClientLabel = authUser.role === 'client'
    ? authUser.clientName
    : clients.find((c) => c.id === manageAccessClientId)?.clientName;
  if (!scopeClientId) return null;

  return (
    <ClientUserManagement
      scopeClientId={scopeClientId}
      clientLabel={scopeClientLabel}
      isMasterAdminView={authUser.role === 'master-admin'}
      users={clientUsers.filter((u) => u.clientId === scopeClientId)}
      roles={roles.filter((r) => r.clientId === scopeClientId)}
      existingUsernames={clientUsers.map((u) => u.username.toLowerCase())}
      onAddUser={onAddUser}
      onUpdateUser={onUpdateUser}
      onDeleteUser={onDeleteUser}
      onToggleUserStatus={onToggleUserStatus}
      onResetPassword={onResetPassword}
      onViewRoles={authUser.role === 'master-admin' ? () => navigate('/roles') : undefined}
      onBackToClients={authUser.role === 'master-admin' ? onBackToClients : undefined}
    />
  );
};
