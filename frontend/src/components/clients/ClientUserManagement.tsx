import React, { useEffect, useMemo, useState } from 'react';
import {
  Search,
  Plus,
  Pencil,
  Trash2,
  RotateCw,
  AlertCircle,
  ArrowLeft,
  KeyRound,
  X,
  Check,
  Copy,
  CheckCheck,
  RefreshCw,
  Crown,
} from 'lucide-react';
import { ClientUserItem, RoleDefinition } from '../../types';

interface ClientUserManagementProps {
  clientLabel?: string;
  isMasterAdminView?: boolean;
  users: ClientUserItem[];
  roles: RoleDefinition[];
  scopeClientId: string;
  existingUsernames: string[];
  onAddUser: (user: ClientUserItem) => void;
  onUpdateUser: (user: ClientUserItem) => void;
  onDeleteUser: (id: string) => void;
  onToggleUserStatus: (id: string) => void;
  onResetPassword: (id: string) => void;
  onViewRoles?: () => void;
  onBackToClients?: () => void;
}

const generatePassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let pwd = '';
  for (let i = 0; i < 10; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
  return pwd;
};

export const ClientUserManagement: React.FC<ClientUserManagementProps> = ({
  clientLabel,
  isMasterAdminView,
  users,
  roles,
  scopeClientId,
  existingUsernames,
  onAddUser,
  onUpdateUser,
  onDeleteUser,
  onToggleUserStatus,
  onResetPassword,
  onViewRoles,
  onBackToClients,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<ClientUserItem | null>(null);
  const [justReset, setJustReset] = useState<string | null>(null);

  const isSuperAdminUser = (user: ClientUserItem) => !!roles.find((r) => r.id === user.roleId)?.isSuperAdminRole;

  const filteredUsers = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return users;
    return users.filter((u) => u.name.toLowerCase().includes(term) || u.username.toLowerCase().includes(term));
  }, [users, searchTerm]);

  const handleReset = (id: string) => {
    onResetPassword(id);
    setJustReset(id);
    setTimeout(() => setJustReset((current) => (current === id ? null : current)), 2000);
  };

  return (
    <div id="client-user-management-view" className="space-y-6">
      {isMasterAdminView && (
        <div className="flex items-center justify-between bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-900 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2 text-sm">
            <button
              onClick={onBackToClients}
              className="flex items-center gap-1.5 text-xs font-semibold text-sky-700 dark:text-sky-300 hover:underline cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Clients</span>
            </button>
            <span className="text-sky-300 dark:text-sky-700">|</span>
            <span className="text-slate-700 dark:text-slate-200">
              Managing users for <strong>{clientLabel}</strong> — Master Admin view
            </span>
          </div>
          {onViewRoles && (
            <button
              onClick={onViewRoles}
              className="flex items-center gap-1.5 text-xs font-semibold text-sky-700 dark:text-sky-300 hover:underline cursor-pointer"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>Roles &amp; Permissions</span>
            </button>
          )}
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 w-full sm:max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search Name or Username..."
            className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
          />
        </div>
        <button
          onClick={() => {
            setEditingUser(null);
            setIsModalOpen(true);
          }}
          className="w-full sm:w-auto px-5 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add User</span>
        </button>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold">
              <tr>
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4">Username</th>
                <th className="py-3 px-4">Role</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredUsers.map((u) => {
                const role = roles.find((r) => r.id === u.roleId);
                const superAdmin = isSuperAdminUser(u);
                return (
                  <tr key={u.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                      {u.name}
                      {superAdmin && <span title="Super Admin"><Crown className="w-3.5 h-3.5 text-amber-500" /></span>}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-300">{u.username}</td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 font-medium text-[11px] border border-sky-200 dark:border-sky-800">
                        {role?.name || 'Unknown role'}
                      </span>
                      {u.mustChangePassword && (
                        <span className="ml-1.5 px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 font-medium text-[10px] border border-amber-200 dark:border-amber-800 uppercase">
                          Awaiting Login
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <button
                        onClick={() => onToggleUserStatus(u.id)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer ${
                          u.active ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'
                        }`}
                        title={u.active ? 'Deactivate user' : 'Activate user'}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${u.active ? 'translate-x-4.5' : 'translate-x-1'}`} />
                      </button>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => handleReset(u.id)}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                          title="Reset password & require change on next login"
                        >
                          <RotateCw className={`w-3.5 h-3.5 ${justReset === u.id ? 'animate-spin' : ''}`} />
                        </button>
                        <button
                          onClick={() => {
                            setEditingUser(u);
                            setIsModalOpen(true);
                          }}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                          title="Edit User"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => !superAdmin && onDeleteUser(u.id)}
                          disabled={superAdmin}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-slate-500 disabled:hover:border-slate-200 transition-colors cursor-pointer"
                          title={superAdmin ? "The Super Admin can't be deleted" : 'Delete User'}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-10">
                    <div className="flex flex-col items-center gap-2 text-slate-400 text-sm">
                      <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
                      <span>No users found.</span>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <AddClientUserModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingUser(null);
        }}
        onSave={(saved) => {
          if (editingUser) {
            onUpdateUser(saved);
          } else {
            onAddUser(saved);
          }
        }}
        existingUsernames={existingUsernames.filter((name) => name !== editingUser?.username.toLowerCase())}
        existingUser={editingUser}
        roles={roles}
        scopeClientId={scopeClientId}
      />
    </div>
  );
};

interface AddClientUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (user: ClientUserItem) => void;
  existingUsernames: string[];
  existingUser?: ClientUserItem | null;
  roles: RoleDefinition[];
  scopeClientId: string;
}

const AddClientUserModal: React.FC<AddClientUserModalProps> = ({
  isOpen,
  onClose,
  onSave,
  existingUsernames,
  existingUser,
  roles,
  scopeClientId,
}) => {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [roleId, setRoleId] = useState('');
  const [active, setActive] = useState(true);
  const [password, setPassword] = useState(generatePassword());
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!isOpen) return;
    if (existingUser) {
      setName(existingUser.name);
      setUsername(existingUser.username);
      setRoleId(existingUser.roleId);
      setActive(existingUser.active);
    } else {
      setName('');
      setUsername('');
      setRoleId(roles.find((r) => !r.isSuperAdminRole)?.id || roles[0]?.id || '');
      setActive(true);
      setPassword(generatePassword());
    }
    setError(undefined);
    setCopied(false);
  }, [isOpen, existingUser, roles]);

  if (!isOpen) return null;

  const isEditing = !!existingUser;
  const isSuperAdminRole = roles.find((r) => r.id === existingUser?.roleId)?.isSuperAdminRole;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = name.trim();
    const finalUsername = username.trim();
    if (!finalName || !finalUsername || !roleId) return;
    if (existingUsernames.includes(finalUsername.toLowerCase())) {
      setError('That username is already taken.');
      return;
    }

    const user: ClientUserItem = isEditing
      ? { ...existingUser!, name: finalName, username: finalUsername, roleId, active }
      : {
          id: `cu-${Date.now()}`,
          clientId: scopeClientId,
          name: finalName,
          username: finalUsername,
          password,
          roleId,
          active,
          mustChangePassword: true,
          createdAt: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
        };

    onSave(user);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">{isEditing ? 'Edit User' : 'Add Client User'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Name <span className="text-rose-500">*</span></label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Priya Sharma"
              className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Username <span className="text-rose-500">*</span></label>
            <input
              type="text"
              required
              value={username}
              onChange={(e) => { setUsername(e.target.value); setError(undefined); }}
              placeholder="e.g. priya.sharma"
              className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Role <span className="text-rose-500">*</span></label>
            <select
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              disabled={!!isSuperAdminRole}
              required
              className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:border-sky-500 cursor-pointer disabled:bg-slate-50 dark:disabled:bg-slate-800/40 disabled:cursor-not-allowed"
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            {isSuperAdminRole && (
              <p className="text-[11px] text-slate-400 mt-1">The Super Admin's role can't be changed.</p>
            )}
          </div>

          {!isEditing && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">Temporary Password</label>
                <button type="button" onClick={() => setPassword(generatePassword())} className="text-[11px] text-sky-600 hover:text-sky-700 dark:text-sky-400 font-medium flex items-center gap-1 cursor-pointer">
                  <RefreshCw className="w-3 h-3" />
                  <span>Regenerate</span>
                </button>
              </div>
              <div className="relative">
                <input
                  type="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 pr-9 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                />
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(password).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {})}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                >
                  {copied ? <CheckCheck className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-1">This user will be required to change it on first login.</p>
            </div>
          )}

          <label className="flex items-center gap-2 cursor-pointer pt-1">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="accent-sky-600 w-4 h-4 cursor-pointer" />
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">Active</span>
          </label>

          {error && (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">{error}</div>
          )}

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer">
              Cancel
            </button>
            <button type="submit" className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer">
              <Check className="w-4 h-4" />
              <span>{isEditing ? 'Save Changes' : 'Create User'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
