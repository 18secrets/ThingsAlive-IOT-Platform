import React from 'react';
import { ClientAccount, ClientUserItem, PlatformUserItem, RoleDefinition } from '../types';
import { UsersHub } from '../components/users/UsersHub';

interface UsersPageProps {
  users: PlatformUserItem[];
  onAddUser: (user: PlatformUserItem) => void;
  onUpdateUser: (user: PlatformUserItem) => void;
  onDeleteUser: (id: number) => void;
  onToggleUserStatus: (id: number) => void;
  clients: ClientAccount[];
  clientUsers: ClientUserItem[];
  roles: RoleDefinition[];
  /** Sets the drill-down and navigates to /client-users. */
  onManageClientAccess: (clientId: string) => void;
}

export const UsersPage: React.FC<UsersPageProps> = (props) => <UsersHub {...props} />;
