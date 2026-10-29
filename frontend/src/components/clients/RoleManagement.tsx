import React, { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, AlertCircle, X, Check, Shield, Info } from 'lucide-react';
import { CheckPicker, Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { TablePagination, usePagination } from '../common/TablePagination';
import { NavigationTab, CLIENT_ASSIGNABLE_TABS } from '../../types';
import { ApiError, RoleInput, RolePatchInput, TenantRole, TenantUser } from '../../lib/api';

// Translation keys, not labels: the sidebar's own names (translation namespace) so a
// page is called the same thing here as where it is opened.
const TAB_LABEL_KEYS: Record<NavigationTab, string> = {
  dashboard: 'translation:sidebar.dashboard',
  'things-care': 'translation:sidebar.thingsCare',
  'things-shield': 'translation:sidebar.thingsShield',
  'incident-management': 'translation:sidebar.incidentManagement',
  'production-monitoring': 'translation:sidebar.productionMonitoring',
  'ai-onboarding': 'translation:sidebar.aiOnboarding',
  'alert-agent': 'translation:pages.alertAgent.title',
  alerts: 'translation:sidebar.alerts',
  // Not grantable yet (not in CLIENT_ASSIGNABLE_TABS or the backend's page list): super
  // admins see the geofence map; the label is here because this record covers every tab.
  geofence: 'translation:sidebar.geofence',
  predictions: 'translation:sidebar.livePredictions',
  scenarios: 'translation:sidebar.scenarios',
  'work-orders': 'translation:sidebar.workOrders',
  'cost-administration': 'translation:sidebar.costAdministration',
  admin: 'users:roles.adminTab',
  settings: 'translation:sidebar.settings',
  users: 'translation:sidebar.users',
  'client-users': 'translation:sidebar.clientUsers',
  roles: 'translation:sidebar.roles',
  // Master Admin's own sidebar pages — never offered here since they're not
  // in CLIENT_ASSIGNABLE_TABS, but Record<NavigationTab, string> is
  // exhaustive over the whole union.
  clients: 'translation:sidebar.clients',
  staff: 'translation:sidebar.staff',
  devices: 'translation:sidebar.devices',
  equipment: 'translation:sidebar.equipment',
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
  const { t } = useTranslation('users');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<TenantRole | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const usersInRole = (slug: string) => users.filter((u) => u.roleSlug === slug).length;

  const handleDelete = async (slug: string) => {
    setBusySlug(slug);
    await onDeleteRole(slug);
    setBusySlug(null);
  };

  const { pageItems: pagedRows, ...pager } = usePagination(roles);

  return (
    <div id="role-management-view" className="space-y-3">
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('roles.intro')}
        </p>
        <button
          onClick={() => { setEditingRole(null); setIsModalOpen(true); }}
          className="px-5 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t('roles.add')}</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {pagedRows.map((role) => {
          const holders = usersInRole(role.slug);
          return (
            <div key={role.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold text-slate-900 dark:text-white text-base flex items-center gap-1.5">
                  {role.name}
                  {role.isBuiltIn && <span title={t('roles.builtIn')}><Shield className="w-4 h-4 text-sky-500" /></span>}
                </h4>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => { setEditingRole(role); setIsModalOpen(true); }}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                    title={t('roles.editTitle')}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => !role.isBuiltIn && holders === 0 && handleDelete(role.slug)}
                    disabled={role.isBuiltIn || holders > 0 || busySlug === role.slug}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    title={role.isBuiltIn ? t('roles.builtInNoDelete') : holders > 0 ? t('roles.hasHolders') : t('roles.delete')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {/* Only ever shows pages still in CLIENT_ASSIGNABLE_TABS — a role
                    saved before a page was retired (e.g. 'alert-agent', which lost
                    its sidebar entry) can still have it sitting in its stored
                    allowedTabs; this keeps that stale grant from showing as if it
                    still meant something. */}
                {role.allowedTabs.filter((tab) => CLIENT_ASSIGNABLE_TABS.includes(tab as NavigationTab)).length === 0 ? (
                  <span className="text-xs text-slate-400 italic">{t('roles.noPages')}</span>
                ) : (
                  role.allowedTabs
                    .filter((tab) => CLIENT_ASSIGNABLE_TABS.includes(tab as NavigationTab))
                    .map((tab) => (
                      <span key={tab} className="px-2 py-0.5 text-xs bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 rounded border border-sky-200 dark:border-sky-800">
                        {TAB_LABEL_KEYS[tab as NavigationTab] ? t(TAB_LABEL_KEYS[tab as NavigationTab]) : tab}
                      </span>
                    ))
                )}
              </div>
              <p className="text-xs text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-800">
                {t('roles.usersAssigned', { count: holders })}
              </p>
            </div>
          );
        })}

        {roles.length === 0 && (
          <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
            <span>{t('roles.empty')}</span>
          </div>
        )}
      </div>
      {roles.length > 0 && <TablePagination bare pinToBottom {...pager} />}

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
  const { t } = useTranslation('users');

  useEffect(() => {
    if (!isOpen) return;
    setName(existingRole?.name ?? '');
    setBasedOnSlug(roles[0]?.slug ?? '');
    // Drop any stale grant for a page that's since lost its sidebar entry
    // (e.g. 'alert-agent') — the checklist below only ever offers
    // CLIENT_ASSIGNABLE_TABS, so an un-rendered stale tab would otherwise
    // silently survive every future save of this role.
    setAllowedTabs(((existingRole?.allowedTabs ?? []) as NavigationTab[]).filter((tab) => CLIENT_ASSIGNABLE_TABS.includes(tab)));
    setError(undefined);
  }, [isOpen, existingRole, roles]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = name.trim();
    if (!finalName) return;
    if (allowedTabs.length === 0) {
      setError(t('roles.needPage'));
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      if (isEditing) {
        await onUpdate(existingRole!.slug, { name: finalName, allowedTabs });
      } else {
        const basedOn = roles.find((r) => r.slug === basedOnSlug);
        if (!basedOn) { setError(t('roles.needBase')); setBusy(false); return; }
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
      setError(err instanceof ApiError ? err.message : (isEditing ? t('roles.saveFailed') : t('roles.createFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40 shrink-0">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">{isEditing ? t('roles.edit') : t('roles.add')}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col min-h-0 flex-1">
          <div className="p-6 space-y-4 text-sm overflow-y-auto min-h-0">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">{t('roles.name')} <span className="text-rose-500">*</span></label>
            <Input
              required
              autoFocus
              value={name}
              onChange={(value) => setName(value)}
              placeholder={t('roles.namePlaceholder')}
            />
          </div>

          {!isEditing && (
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('roles.basedOn')} <span className="text-rose-500">*</span>
              </label>
              <SelectPicker
                data={roles.map((r) => ({ label: r.name, value: r.slug }))}
                value={basedOnSlug}
                onChange={(value) => setBasedOnSlug(value ?? '')}
                block
                searchable={false}
                cleanable={false}
              />
              <p className="text-xs text-slate-400 mt-1">
                {t('roles.basedOnHint')}
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">{t('roles.pages')} <span className="text-rose-500">*</span></label>
            <CheckPicker
              data={CLIENT_ASSIGNABLE_TABS.map((tab) => ({ label: t(TAB_LABEL_KEYS[tab]), value: tab }))}
              value={allowedTabs}
              onChange={(values) => setAllowedTabs(values ?? [])}
              block
              searchable={CLIENT_ASSIGNABLE_TABS.length > 6}
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              <Info className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          </div>

          <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3 shrink-0">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer">
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={busy} className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed">
              <Check className="w-4 h-4" />
              <span>{busy ? t('common.saving') : (isEditing ? t('common.saveChanges') : t('roles.create'))}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
