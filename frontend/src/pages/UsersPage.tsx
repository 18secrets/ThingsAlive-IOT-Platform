import React from 'react';
import { ClientAccount, ClientUserItem, RoleDefinition } from '../types';
import { InvitePlatformStaffResult, PlatformStaffMember, PlatformStaffRole } from '../lib/api';
import { UsersHub } from '../components/users/UsersHub';

interface UsersPageProps {
  staff: PlatformStaffMember[];
  staffError?: string;
  onInviteStaff: (input: {
    email: string; fullName: string; role: PlatformStaffRole;
  }) => Promise<InvitePlatformStaffResult>;
  onSetStaffRole: (id: string, role: PlatformStaffRole) => Promise<void>;
  onSuspendStaff: (id: string, reason: string) => Promise<void>;
  onReinstateStaff: (id: string) => Promise<void>;
  clients: ClientAccount[];
  clientUsers: ClientUserItem[];
  roles: RoleDefinition[];
  /** Sets the drill-down and navigates to /client-users. */
  onManageClientAccess: (clientId: string) => void;
}

export const UsersPage: React.FC<UsersPageProps> = (props) => <UsersHub {...props} />;
