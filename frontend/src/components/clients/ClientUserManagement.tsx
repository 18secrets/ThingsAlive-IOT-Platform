import React, { useEffect, useMemo, useState } from 'react';
import {
  Search, Plus, AlertCircle, X, Check, Copy, CheckCheck, Crown, Ban, RotateCcw,
} from 'lucide-react';
import { ApiError, InviteUserInput, InviteUserResult, TenantRole, TenantUser } from '../../lib/api';

interface ClientUserManagementProps {
  users: TenantUser[];
  roles: TenantRole[];
  error?: string;
  onInviteUser: (input: InviteUserInput) => Promise<InviteUserResult>;
  onSetUserRole: (userId: string, roleSlug: string) => Promise<TenantUser>;
  onSuspendUser: (userId: string, reason: string) => Promise<TenantUser>;
  onReinstateUser: (userId: string) => Promise<TenantUser>;
}

const STATUS_STYLE: Record<TenantUser['status'], string> = {
  invited: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  active: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  suspended: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
};

export const ClientUserManagement: React.FC<ClientUserManagementProps> = ({
  users, roles, error, onInviteUser, onSetUserRole, onSuspendUser, onReinstateUser,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const roleName = useMemo(() => {
    const byId = new Map(roles.map((r) => [r.slug, r.name]));
    return (slug: string) => byId.get(slug) ?? slug;
  }, [roles]);

  const isSuperAdminUser = (user: TenantUser) => {
    const role = roles.find((r) => r.slug === user.roleSlug);
    return !!(role?.capabilities.includes('user.manage') && role?.capabilities.includes('role.manage'));
  };

  const filteredUsers = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return users;
    return users.filter((u) => u.fullName.toLowerCase().includes(term) || u.email.toLowerCase().includes(term));
  }, [users, searchTerm]);

  const runAction = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setActionError(undefined);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'That action failed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div id="client-user-management-view" className="space-y-6">
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 w-full sm:max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search Name or Email..."
            className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
          />
        </div>
        <button
          onClick={() => setIsModalOpen(true)}
          className="w-full sm:w-auto px-5 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Invite User</span>
        </button>
      </div>

      {(error || actionError) && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error || actionError}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold">
              <tr>
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4">Email</th>
                <th className="py-3 px-4">Role</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredUsers.map((u) => {
                const superAdmin = isSuperAdminUser(u);
                const busy = busyId === u.id;
                return (
                  <tr key={u.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">
                      <span className="flex items-center gap-1.5">
                        {u.fullName}
                        {superAdmin && <span title="Super Admin"><Crown className="w-3.5 h-3.5 text-amber-500" /></span>}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-300">{u.email}</td>
                    <td className="py-3 px-4">
                      <select
                        value={u.roleSlug}
                        disabled={busy}
                        onChange={(e) => runAction(u.id, () => onSetUserRole(u.id, e.target.value))}
                        className="px-2 py-1 rounded bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 font-medium text-[11px] border border-sky-200 dark:border-sky-800 cursor-pointer disabled:opacity-50"
                      >
                        {roles.map((r) => (
                          <option key={r.slug} value={r.slug}>{r.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATUS_STYLE[u.status]}`}>
                        {u.status}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-center gap-2">
                        {u.status === 'suspended' ? (
                          <button
                            onClick={() => runAction(u.id, () => onReinstateUser(u.id))}
                            disabled={busy}
                            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-emerald-600 hover:border-emerald-300 disabled:opacity-30 transition-colors cursor-pointer"
                            title="Reinstate"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              const reason = window.prompt(`Why is ${u.fullName} being suspended?`);
                              if (reason) runAction(u.id, () => onSuspendUser(u.id, reason));
                            }}
                            disabled={busy || superAdmin}
                            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                            title={superAdmin ? "The Super Admin can't be suspended" : 'Suspend'}
                          >
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        )}
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

      <InviteUserModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onInvite={onInviteUser}
        roles={roles}
      />
    </div>
  );
};

interface InviteUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInvite: (input: InviteUserInput) => Promise<InviteUserResult>;
  roles: TenantRole[];
}

const InviteUserModal: React.FC<InviteUserModalProps> = ({ isOpen, onClose, onInvite, roles }) => {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [roleSlug, setRoleSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [invited, setInvited] = useState<InviteUserResult | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setFullName('');
    setEmail('');
    setPhone('');
    setRoleSlug(roles.find((r) => !r.capabilities.includes('user.manage'))?.slug ?? roles[0]?.slug ?? '');
    setError(undefined);
    setInvited(null);
    setCopied(false);
  }, [isOpen, roles]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = fullName.trim();
    const finalEmail = email.trim();
    if (!finalName || !finalEmail || !roleSlug) return;

    setBusy(true);
    setError(undefined);
    try {
      const result = await onInvite({
        email: finalEmail, fullName: finalName, roleSlug, phone: phone.trim() || undefined,
      });
      setInvited(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not invite this person.');
    } finally {
      setBusy(false);
    }
  };

  const handleCopyToken = () => {
    if (!invited?.invitationToken) return;
    navigator.clipboard?.writeText(invited.invitationToken).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">
            {invited ? 'Invitation Sent' : 'Invite User'}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {invited ? (
          <div className="p-6 space-y-4 text-sm">
            <p className="text-slate-600 dark:text-slate-300">
              <strong className="text-slate-900 dark:text-white">{invited.fullName}</strong> can accept with this token.
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Invitation Token</label>
              <div className="relative">
                <input readOnly value={invited.invitationToken ?? ''} className="w-full px-3 py-2 pr-9 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 font-mono" />
                <button type="button" onClick={handleCopyToken} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer" title="Copy token">
                  {copied ? <CheckCheck className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              {invited.invitationExpiresAt && (
                <p className="text-[11px] text-slate-400 mt-1">
                  Expires {new Date(invited.invitationExpiresAt).toLocaleString()}. There is no password to hand
                  over — they set their own via the accept-invitation link with this token.
                </p>
              )}
            </div>
            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-end">
              <button onClick={onClose} className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs transition-colors cursor-pointer">
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Full Name <span className="text-rose-500">*</span></label>
              <input
                type="text"
                required
                autoFocus
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Priya Sharma"
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Email <span className="text-rose-500">*</span></label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="e.g. priya.sharma@example.com"
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
              />
              <p className="text-[11px] text-slate-400 mt-1">This is how they'll sign in — there is no separate username.</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="e.g. +91 98100 22341"
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Role <span className="text-rose-500">*</span></label>
              <select
                value={roleSlug}
                onChange={(e) => setRoleSlug(e.target.value)}
                required
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:border-sky-500 cursor-pointer"
              >
                {roles.map((r) => (
                  <option key={r.slug} value={r.slug}>{r.name}</option>
                ))}
              </select>
            </div>

            {error && (
              <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">{error}</div>
            )}

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
              <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed">
                <Check className="w-4 h-4" />
                <span>{busy ? 'Inviting…' : 'Send Invitation'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
