import React from 'react';
import {
  InviteUserInput, InviteUserResult, TenantRole, TenantUser,
} from '../lib/api';
import { useAuth } from '../lib/AuthProvider';
import { ClientUserManagement } from '../components/clients/ClientUserManagement';
import { NotAvailableNotice } from '../components/NotAvailableNotice';

interface ClientUsersPageProps {
  users: TenantUser[];
  roles: TenantRole[];
  error?: string;
  /** Master Admin's drill-down pick from the Clients tab — absent for a client's own view. */
  manageAccessClientId: string | null;
  onBackToClients: () => void;
  onInviteUser: (input: InviteUserInput) => Promise<InviteUserResult>;
  onSetUserRole: (userId: string, roleSlug: string) => Promise<TenantUser>;
  onSuspendUser: (userId: string, reason: string) => Promise<TenantUser>;
  onReinstateUser: (userId: string) => Promise<TenantUser>;
}

export const ClientUsersPage: React.FC<ClientUsersPageProps> = ({
  users, roles, error, manageAccessClientId, onBackToClients,
  onInviteUser, onSetUserRole, onSuspendUser, onReinstateUser,
}) => {
  const { authUser } = useAuth();
  if (!authUser) return null;

  // user.manage is that account's own super admin only — there is no cross-tenant
  // read or write for it, so a Master Admin drilling into a specific client from
  // the Clients tab has nothing real to see here yet.
  if (authUser.role === 'master-admin' || manageAccessClientId) {
    return (
      <NotAvailableNotice title="Not available yet" onBack={onBackToClients}>
        Managing another account's users is the account's own super admin's call —
        there is no Master Admin route for it today.
      </NotAvailableNotice>
    );
  }

  return (
    <ClientUserManagement
      users={users}
      roles={roles}
      error={error}
      onInviteUser={onInviteUser}
      onSetUserRole={onSetUserRole}
      onSuspendUser={onSuspendUser}
      onReinstateUser={onReinstateUser}
    />
  );
};
