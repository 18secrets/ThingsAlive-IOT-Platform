import React, { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, AlertCircle, X, Check, Shield, Info } from 'lucide-react';
import { useAuth } from '../../lib/AuthProvider';
import { CheckPicker, Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { LIST_PANEL, TablePagination, usePagination } from '../common/TablePagination';
import { ListTable } from '../common/ListTable';
import { ViewModeToggle, useViewMode } from '../common/ViewModeToggle';
import { CLIENT_ADMIN_SUBTABS, CLIENT_ADMIN_TAB_GRANTS, CLIENT_ASSIGNABLE_TABS, ClientAdminSubTab, NavigationTab, RolePageGrant, adminTabGrant } from '../../types';
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

// Administration's own tab names, as its tab bar shows them.
const ADMIN_TAB_LABEL_KEYS: Record<ClientAdminSubTab, string> = {
  plant: 'admin:tabs.plant',
  devices: 'translation:sidebar.devices',
  equipment: 'translation:sidebar.equipment',
  model: 'admin:tabs.models',
  'service-roster': 'admin:tabs.serviceRoster',
  'fuel-forecast-accuracy': 'admin:tabs.fuelForecastAccuracy',
};

/**
 * What the form offers: every sidebar page, then each Administration tab on its own
 * (13 Nov 2026). "admin" itself is not offered — the role holds it exactly when one of
 * its tabs is ticked, so the two can never disagree.
 */
const OFFERED_GRANTS: RolePageGrant[] = [...CLIENT_ASSIGNABLE_TABS.filter((tab) => tab !== 'admin'), ...CLIENT_ADMIN_TAB_GRANTS];
const isOffered = (grant: string): grant is RolePageGrant => (OFFERED_GRANTS as string[]).includes(grant);
const isAdminTabGrant = (grant: string) => (CLIENT_ADMIN_TAB_GRANTS as string[]).includes(grant);

function grantLabel(t: (key: string) => string, grant: RolePageGrant): string {
  const tab = CLIENT_ADMIN_SUBTABS.find((sub) => adminTabGrant(sub) === grant);
  return tab ? `${t('users:roles.adminGroup')} · ${t(ADMIN_TAB_LABEL_KEYS[tab])}` : t(TAB_LABEL_KEYS[grant as NavigationTab]);
}

/** The pages as saved: the Administration entry held whenever any of its tabs is. */
const withAdminEntry = (grants: RolePageGrant[]): RolePageGrant[] => {
  const pages = grants.filter((g) => g !== 'admin');
  return pages.some(isAdminTabGrant) ? [...pages, 'admin'] : pages;
};

/** The account's owner opens every page; its list is not theirs to narrow (the API refuses it). */
const OWNER_ROLE = 'ceo-manager';

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
  const { t } = useTranslation(['users', 'admin']);
  const { t: ts } = useTranslation('shared');
  const [viewMode, setViewMode] = useViewMode('roles');
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

  type Role = (typeof pagedRows)[number];
  // The card's controls, shared with the list row.
  // A role that manages people or roles is the CEO / Manager's to edit or copy (TC_193–196),
  // as the server rules it; an Admin is offered only what it may do.
  const { authUser } = useAuth();
  const isOwner = !!authUser?.isSuperAdmin;
  const managesPeople = (r: Role) =>
    r.slug === 'ceo-manager' || r.capabilities.includes('user.manage') || r.capabilities.includes('role.manage');
  const actions = (role: Role, holders: number) => (
                <div className="flex items-center gap-1.5">
                  {/* The reason sits on a wrapper: a disabled button shows no tooltip. */}
                  <span className="inline-flex" title={!isOwner && managesPeople(role) ? t('roles.ownerOnly') : t('roles.editTitle')}>
                  <button
                    onClick={() => { setEditingRole(role); setIsModalOpen(true); }}
                    disabled={!isOwner && managesPeople(role)}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 enabled:hover:text-sky-600 enabled:hover:border-sky-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    aria-label={t('roles.editTitle')}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  </span>
                  <button
                    onClick={() => !role.isBuiltIn && holders === 0 && handleDelete(role.slug)}
                    disabled={role.isBuiltIn || holders > 0 || busySlug === role.slug}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    title={role.isBuiltIn ? t('roles.builtInNoDelete') : holders > 0 ? t('roles.hasHolders') : t('roles.delete')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
  );
  const pageChips = (role: Role) => (
    <>
                {/* Only ever shows pages still in CLIENT_ASSIGNABLE_TABS — a role
                    saved before a page was retired (e.g. 'alert-agent', which lost
                    its sidebar entry) can still have it sitting in its stored
                    allowedTabs; this keeps that stale grant from showing as if it
                    still meant something. */}
                {role.slug === OWNER_ROLE ? (
                  <span className="px-2 py-0.5 text-xs bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 rounded border border-sky-200 dark:border-sky-800">
                    {t('roles.everyPage')}
                  </span>
                ) : role.allowedTabs.filter(isOffered).length === 0 ? (
                  <span className="text-xs text-slate-400 italic">{t('roles.noPages')}</span>
                ) : (
                  OFFERED_GRANTS
                    .filter((tab) => role.allowedTabs.includes(tab))
                    .map((tab) => (
                      <span key={tab} className="px-2 py-0.5 text-xs bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 rounded border border-sky-200 dark:border-sky-800">
                        {grantLabel(t, tab)}
                      </span>
                    ))
                )}
    </>
  );

  return (
    <div id="role-management-view" className="space-y-3">
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('roles.intro')}
        </p>
        <div className="flex items-center gap-3 shrink-0">
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        <button
          onClick={() => { setEditingRole(null); setIsModalOpen(true); }}
          className="px-5 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t('roles.add')}</span>
        </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className={LIST_PANEL}>
        {viewMode === 'list' && roles.length > 0 ? (
          <ListTable bare
            // Sized to content, as the other lists are: the page chips get the room, a
            // count and two icons are narrow, and the actions sit right.
            columns={[
              { label: ts('listCol.name'), grow: 2, minWidth: 140 },
              { label: ts('listCol.pages'), grow: 5, minWidth: 220 },
              { label: ts('listCol.users'), align: 'right', width: 90 },
              { label: ts('listCol.actions'), align: 'right', width: 100 },
            ]}
            rows={pagedRows}
            rowKey={(role) => role.id}
            cells={(role) => [
              <span className="font-medium inline-flex items-center gap-1.5">
                {role.name}
                {role.isBuiltIn && <span title={t('roles.builtIn')}><Shield className="w-4 h-4 text-sky-500" /></span>}
              </span>,
              <div className="flex flex-wrap gap-1.5">{pageChips(role)}</div>,
              usersInRole(role.slug),
              <div className="flex justify-end">{actions(role, usersInRole(role.slug))}</div>,
            ]}
          />
        ) : (
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          {pagedRows.map((role) => {
            const holders = usersInRole(role.slug);
            return (
              <div key={role.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-slate-900 dark:text-white text-base flex items-center gap-1.5">
                    {role.name}
                    {role.isBuiltIn && <span title={t('roles.builtIn')}><Shield className="w-4 h-4 text-sky-500" /></span>}
                  </h4>
                  {actions(role, holders)}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {pageChips(role)}
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
        )}
        {roles.length > 0 && <TablePagination pinToBottom {...pager} />}
      </div>

      <AddRoleModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingRole(null); }}
        onCreate={onCreateRole}
        onUpdate={onUpdateRole}
        existingRole={editingRole}
        roles={isOwner ? roles : roles.filter((r) => !managesPeople(r))}
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
  const [allowedTabs, setAllowedTabs] = useState<RolePageGrant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isEditing = !!existingRole;
  const isOwnerRole = existingRole?.slug === OWNER_ROLE;
  const { t } = useTranslation(['users', 'admin']);

  useEffect(() => {
    if (!isOpen) return;
    setName(existingRole?.name ?? '');
    setBasedOnSlug(roles[0]?.slug ?? '');
    // Drop any stale grant for a page that's since lost its sidebar entry
    // (e.g. 'alert-agent') — the checklist below only ever offers
    // CLIENT_ASSIGNABLE_TABS, so an un-rendered stale tab would otherwise
    // silently survive every future save of this role.
    setAllowedTabs((existingRole?.allowedTabs ?? []).filter(isOffered));
    setError(undefined);
  }, [isOpen, existingRole, roles]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = name.trim();
    if (!finalName) return;
    if (!isOwnerRole && allowedTabs.length === 0) {
      setError(t('roles.needPage'));
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      if (isEditing) {
        await onUpdate(existingRole!.slug, isOwnerRole ? { name: finalName } : { name: finalName, allowedTabs: withAdminEntry(allowedTabs) });
      } else {
        const basedOn = roles.find((r) => r.slug === basedOnSlug);
        if (!basedOn) { setError(t('roles.needBase')); setBusy(false); return; }
        await onCreate({
          slug: slugify(finalName) || `role-${Date.now()}`,
          name: finalName,
          capabilities: basedOn.capabilities,
          scopeShape: basedOn.scopeShape,
          allowedTabs: withAdminEntry(allowedTabs),
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
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">{t('roles.pages')} {!isOwnerRole && <span className="text-rose-500">*</span>}</label>
            {isOwnerRole ? (
              <p className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
                <Info className="w-4 h-4 mt-0.5 shrink-0 text-sky-600" />
                <span>{t('roles.ownerEveryPage')}</span>
              </p>
            ) : (
            <CheckPicker
              data={OFFERED_GRANTS.map((tab) => ({
                label: grantLabel(t, tab), value: tab,
                group: isAdminTabGrant(tab) ? t('roles.adminGroup') : t('roles.pagesGroup'),
              }))}
              groupBy="group"
              value={allowedTabs}
              onChange={(values) => setAllowedTabs(values ?? [])}
              block
              searchable
            />
            )}
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
