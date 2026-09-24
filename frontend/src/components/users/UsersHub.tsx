import React, { useState } from 'react';
import { Building2, ShieldCheck } from 'lucide-react';
import { PlatformUserItem, ClientAccount, ClientUserItem, RoleDefinition } from '../../types';
import { UserManagement } from './UserManagement';
import { AllClientUsersView } from './AllClientUsersView';

interface UsersHubProps {
  users: PlatformUserItem[];
  onAddUser: (user: PlatformUserItem) => void;
  onUpdateUser: (user: PlatformUserItem) => void;
  onDeleteUser: (id: number) => void;
  onToggleUserStatus: (id: number) => void;
  clients: ClientAccount[];
  clientUsers: ClientUserItem[];
  roles: RoleDefinition[];
  onManageClientAccess: (clientId: string) => void;
}

type UsersSubTab = 'platform' | 'clients';

export const UsersHub: React.FC<UsersHubProps> = ({
  users,
  onAddUser,
  onUpdateUser,
  onDeleteUser,
  onToggleUserStatus,
  clients,
  clientUsers,
  roles,
  onManageClientAccess,
}) => {
  const [subTab, setSubTab] = useState<UsersSubTab>('platform');

  const tabs: { id: UsersSubTab; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'platform', label: 'Platform Users', icon: ShieldCheck },
    { id: 'clients', label: 'Client Users', icon: Building2 },
  ];

  return (
    <div id="users-hub-view" className="space-y-5">
      <div className="flex items-center gap-2.5">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = subTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setSubTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium rounded-lg border transition-all flex items-center gap-2 cursor-pointer ${
                isActive
                  ? 'bg-sky-100 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-700 shadow-xs font-semibold'
                  : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-sky-600 dark:text-sky-400' : 'text-slate-500 dark:text-slate-400'}`} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {subTab === 'platform' ? (
        <UserManagement
          users={users}
          onAddUser={onAddUser}
          onUpdateUser={onUpdateUser}
          onDeleteUser={onDeleteUser}
          onToggleUserStatus={onToggleUserStatus}
        />
      ) : (
        <AllClientUsersView
          clients={clients}
          clientUsers={clientUsers}
          roles={roles}
          onManage={onManageClientAccess}
        />
      )}
    </div>
  );
};
