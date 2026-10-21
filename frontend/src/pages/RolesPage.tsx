import React from 'react';
import { useTranslation } from 'react-i18next';
import { RoleInput, RolePatchInput, TenantRole, TenantUser } from '../lib/api';
import { useAuth } from '../lib/AuthProvider';
import { RoleManagement } from '../components/clients/RoleManagement';
import { NotAvailableNotice } from '../components/NotAvailableNotice';

interface RolesPageProps {
  roles: TenantRole[];
  users: TenantUser[];
  error?: string;
  manageAccessClientId: string | null;
  onBackToClients: () => void;
  onCreateRole: (input: RoleInput) => Promise<TenantRole>;
  onUpdateRole: (slug: string, input: RolePatchInput) => Promise<TenantRole>;
  onDeleteRole: (slug: string) => Promise<void>;
}

export const RolesPage: React.FC<RolesPageProps> = ({
  roles, users, error, manageAccessClientId, onBackToClients, onCreateRole, onUpdateRole, onDeleteRole,
}) => {
  const { authUser } = useAuth();
  const { t } = useTranslation('users');
  if (!authUser) return null;

  // role.manage is that account's own super admin only — see ClientUsersPage's
  // own comment on the same boundary.
  if (authUser.role === 'master-admin' || manageAccessClientId) {
    return (
      <NotAvailableNotice title={t('common.notAvailableYet')} onBack={onBackToClients}>
        {t('notAvailable.roles')}
      </NotAvailableNotice>
    );
  }

  return (
    <RoleManagement
      roles={roles}
      users={users}
      error={error}
      onCreateRole={onCreateRole}
      onUpdateRole={onUpdateRole}
      onDeleteRole={onDeleteRole}
    />
  );
};
