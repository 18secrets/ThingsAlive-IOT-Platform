import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ClientAccount, ClientUserItem, RoleDefinition } from '../types';
import { useAuth } from '../lib/AuthProvider';
import { RoleManagement } from '../components/clients/RoleManagement';

interface RolesPageProps {
  clients: ClientAccount[];
  clientUsers: ClientUserItem[];
  roles: RoleDefinition[];
  manageAccessClientId: string | null;
  onBackToClients: () => void;
  onAddRole: (role: RoleDefinition) => void;
  onUpdateRole: (role: RoleDefinition) => void;
  onDeleteRole: (id: string) => void;
}

export const RolesPage: React.FC<RolesPageProps> = ({
  clients, clientUsers, roles, manageAccessClientId, onBackToClients,
  onAddRole, onUpdateRole, onDeleteRole,
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
    <RoleManagement
      scopeClientId={scopeClientId}
      clientLabel={scopeClientLabel}
      isMasterAdminView={authUser.role === 'master-admin'}
      roles={roles.filter((r) => r.clientId === scopeClientId)}
      users={clientUsers.filter((u) => u.clientId === scopeClientId)}
      onAddRole={onAddRole}
      onUpdateRole={onUpdateRole}
      onDeleteRole={onDeleteRole}
      onViewUsers={authUser.role === 'master-admin' ? () => navigate('/client-users') : undefined}
      onBackToClients={authUser.role === 'master-admin' ? onBackToClients : undefined}
    />
  );
};
