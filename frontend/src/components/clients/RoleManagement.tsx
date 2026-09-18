import React, { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, AlertCircle, X, Check, Shield, Info } from 'lucide-react';
import { NavigationTab, CLIENT_ASSIGNABLE_TABS } from '../../types';
import { ApiError, RoleInput, RolePatchInput, TenantRole, TenantUser } from '../../lib/api';

const TAB_LABELS: Record<NavigationTab, string> = {
  dashboard: 'Dashboard',
  'ai-onboarding': 'AI Onboarding',
  'alert-agent': 'Alert Agent',
  admin: 'Administration (Plants, Devices, Equipment)',
  settings: 'Settings',
  users: 'Users',
  'client-users': 'Client Users',
  roles: 'Roles & Permissions',
};

interface RoleManagementProps {
  roles: TenantRole[];
  users: TenantUser[];
  error?: string;
  onCreateRole: (input: RoleInput) => Promise<TenantRole>;
  onUpdateRole: (slug: string, input: RolePatchInput) => Promise<TenantRole>;
  onDeleteRole: (slug: string) => Promise<void>;
}

export const RoleManagement: React.FC<RoleManagementProps> = ({
  roles, users, error, onCreateRole, onUpdateRole, onDeleteRole,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<TenantRole | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const usersInRole = (slug: string) => users.filter((u) => u.roleSlug === slug).length;

  const handleDelete = async (slug: string) => {
    setBusySlug(slug);
    await onDeleteRole(slug);
    setBusySlug(null);
  };

  return (
    <div id="role-management-view" className="space-y-6">
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          A role decides which pages its users can open, and what its users can do —
          two different questions, both bundled into every custom role.
        </p>
        <button
          onClick={() => { setEditingRole(null); setIsModalOpen(true); }}
          className="px-5 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add Role</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {roles.map((role) => {
          const holders = usersInRole(role.slug);
          return (
            <div key={role.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold text-slate-900 dark:text-white text-base flex items-center gap-1.5">
                  {role.name}
                  {role.isBuiltIn && <span title="One of the roles every account starts with"><Shield className="w-3.5 h-3.5 text-sky-500" /></span>}
                </h4>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => { setEditingRole(role); setIsModalOpen(true); }}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                    title="Edit name and pages"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => !role.isBuiltIn && holders === 0 && handleDelete(role.slug)}
                    disabled={role.isBuiltIn || holders > 0 || busySlug === role.slug}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    title={role.isBuiltIn ? "One of the roles every account starts with — can't be deleted" : holders > 0 ? 'Move its holders to another role first' : 'Delete Role'}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {role.allowedTabs.length === 0 ? (
                  <span className="text-[11px] text-slate-400 italic">No pages granted</span>
                ) : (
                  role.allowedTabs.map((tab) => (
                    <span key={tab} className="px-2 py-0.5 text-[11px] bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 rounded border border-sky-200 dark:border-sky-800">
                      {TAB_LABELS[tab as NavigationTab] ?? tab}
                    </span>
                  ))
                )}
              </div>
              <p className="text-[11px] text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-800">
                {holders} {holders === 1 ? 'user' : 'users'} assigned
              </p>
            </div>
          );
        })}

        {roles.length === 0 && (
          <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
            <span>No roles found.</span>
          </div>
        )}
      </div>

      <AddRoleModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingRole(null); }}
        onCreate={onCreateRole}
        onUpdate={onUpdateRole}
        existingRole={editingRole}
        roles={roles}
      />
    </div>
  );
};

const slugify = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

interface AddRoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: RoleInput) => Promise<TenantRole>;
  onUpdate: (slug: string, input: RolePatchInput) => Promise<TenantRole>;
  existingRole?: TenantRole | null;
  roles: TenantRole[];
}

const AddRoleModal: React.FC<AddRoleModalProps> = ({ isOpen, onClose, onCreate, onUpdate, existingRole, roles }) => {
  const [name, setName] = useState('');
  const [basedOnSlug, setBasedOnSlug] = useState('');
  const [allowedTabs, setAllowedTabs] = useState<NavigationTab[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = !!existingRole;

  useEffect(() => {
    if (!isOpen) return;
    setName(existingRole?.name ?? '');
    setBasedOnSlug(roles[0]?.slug ?? '');
    setAllowedTabs((existingRole?.allowedTabs ?? []) as NavigationTab[]);
    setError(undefined);
  }, [isOpen, existingRole, roles]);

  if (!isOpen) return null;

  const toggleTab = (tab: NavigationTab) => {
    setAllowedTabs((prev) => (prev.includes(tab) ? prev.filter((t) => t !== tab) : [...prev, tab]));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = name.trim();
    if (!finalName) return;
    if (allowedTabs.length === 0) {
      setError('Grant at least one page to this role.');
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      if (isEditing) {
        await onUpdate(existingRole!.slug, { name: finalName, allowedTabs });
      } else {
        const basedOn = roles.find((r) => r.slug === basedOnSlug);
        if (!basedOn) { setError('Pick a role to base this one on.'); setBusy(false); return; }
        await onCreate({
          slug: slugify(finalName) || `role-${Date.now()}`,
          name: finalName,
          capabilities: basedOn.capabilities,
          scopeShape: basedOn.scopeShape,
          allowedTabs,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${isEditing ? 'save' : 'create'} the role.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">{isEditing ? 'Edit Role' : 'Add Role'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Role Name <span className="text-rose-500">*</span></label>
            <input
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Plant Manager"
              className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
            />
          </div>

          {!isEditing && (
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Based on <span className="text-rose-500">*</span>
              </label>
              <select
                required
                value={basedOnSlug}
                onChange={(e) => setBasedOnSlug(e.target.value)}
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:border-sky-500 cursor-pointer"
              >
                {roles.map((r) => (
                  <option key={r.slug} value={r.slug}>{r.name}</option>
                ))}
              </select>
              <p className="text-[10px] text-slate-400 mt-1">
                What this role can do (not just which pages) starts as a copy of the role you pick here.
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Pages this role can open <span className="text-rose-500">*</span></label>
            <div className="space-y-2">
              {CLIENT_ASSIGNABLE_TABS.map((tab) => (
                <label key={tab} className="flex items-center gap-2.5 p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <input
                    type="checkbox"
                    checked={allowedTabs.includes(tab)}
                    onChange={() => toggleTab(tab)}
                    className="accent-sky-600 w-4 h-4 cursor-pointer"
                  />
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{TAB_LABELS[tab]}</span>
                </label>
              ))}
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              <Info className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer">
              Cancel
            </button>
            <button type="submit" disabled={busy} className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed">
              <Check className="w-4 h-4" />
              <span>{busy ? 'Saving…' : (isEditing ? 'Save Changes' : 'Create Role')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
