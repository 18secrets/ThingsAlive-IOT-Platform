import React, { useEffect, useMemo, useState } from 'react';
import {
  Search, Plus, AlertCircle, X, Check, Copy, CheckCheck, Crown, Ban, RotateCcw, RotateCw, MapPin, Trash2,
} from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { Trans, useTranslation } from 'react-i18next';
import {
  ApiError, EquipmentProfile, InviteUserInput, InviteUserResult, Plant, ResendInvitationResult, SetUserAccessInput,
  TenantRole, TenantUser, apiResendUserInvitation,
} from '../../lib/api';
import { TablePagination, usePagination } from '../common/TablePagination';
import { copyToClipboard } from '../../lib/clipboard';
import { InvitationTokenDialog } from '../common/InvitationTokenDialog';
import { EditUserAccessModal } from './EditUserAccessModal';
import { ListTable } from '../common/ListTable';
import { RecordCards } from '../common/RecordCards';
import { ViewModeToggle, useViewMode } from '../common/ViewModeToggle';

interface ClientUserManagementProps {
  users: TenantUser[];
  roles: TenantRole[];
  error?: string;
  onInviteUser: (input: InviteUserInput) => Promise<InviteUserResult>;
  onSetUserRole: (userId: string, roleSlug: string) => Promise<TenantUser>;
  onSuspendUser: (userId: string, reason: string) => Promise<TenantUser>;
  onReinstateUser: (userId: string) => Promise<TenantUser>;
  onDeleteUser: (userId: string) => Promise<void>;
  plants: Plant[];
  equipment: EquipmentProfile[];
  onSetUserAccess: (userId: string, input: SetUserAccessInput) => Promise<TenantUser>;
}

const STATUS_STYLE: Record<TenantUser['status'], string> = {
  invited: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  active: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  suspended: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
};

export const ClientUserManagement: React.FC<ClientUserManagementProps> = ({
  users, roles, error, onInviteUser, onSetUserRole, onSuspendUser, onReinstateUser, onDeleteUser,
  plants, equipment, onSetUserAccess,
}) => {
  const { t } = useTranslation('users');
  const [viewMode, setViewMode] = useViewMode('client-users');
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [accessUser, setAccessUser] = useState<TenantUser | null>(null);
  const [reissued, setReissued] = useState<ResendInvitationResult | null>(null);

  const roleName = useMemo(() => {
    const byId = new Map(roles.map((r) => [r.slug, r.name]));
    return (slug: string) => byId.get(slug) ?? slug;
  }, [roles]);

  const isSuperAdminUser = (user: TenantUser) => {
    const role = roles.find((r) => r.slug === user.roleSlug);
    return !!(role?.capabilities.includes('user.manage') && role?.capabilities.includes('role.manage'));
  };

  // Mirrors the backend's own invariant exactly (ck_app_user_ceo_manager_retained,
  // SuperAdminRetention migration) — keyed on the literal 'ceo-manager' slug, not on
  // a capability combination a custom role could also happen to have. Reassigning
  // this account's only ceo-manager elsewhere would leave nobody who can manage
  // users or roles here, with no way back short of a direct database fix — which is
  // exactly what happened to two live accounts before this guard existed.
  const ceoManagerCount = users.filter((u) => u.roleSlug === 'ceo-manager').length;
  const isLastCeoManager = (user: TenantUser) => user.roleSlug === 'ceo-manager' && ceoManagerCount <= 1;

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
      setActionError(err instanceof ApiError ? err.message : t('clientUsers.actionFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const { pageItems: pagedRows, ...pager } = usePagination(filteredUsers);


  // One definition for both views (tester request: cards or list on every list page).
  const viewColumns = [
    { label: t('col.name') },
    { label: t('col.email') },
    { label: t('col.role') },
    { label: t('col.status') },
    { label: t('col.actions') },
  ];
  const viewCells = (u: (typeof pagedRows)[number]) => {

                const superAdmin = isSuperAdminUser(u);
                const lastCeoManager = isLastCeoManager(u);
                const busy = busyId === u.id;
                const userScopeShape = roles.find((r) => r.slug === u.roleSlug)?.scopeShape;
    return [
      <span className="font-semibold text-slate-900 dark:text-white"><span className="flex items-center gap-1.5">
                        {u.fullName}
                        {superAdmin && <span title={t('common.superAdmin')}><Crown className="w-4 h-4 text-amber-500" /></span>}
                      </span></span>,
      <span className="font-mono text-slate-600 dark:text-slate-300">{u.email}</span>,
      <><span title={lastCeoManager ? t('clientUsers.lastCeoManager') : undefined}>
                        <SelectPicker
                          data={roles.map((r) => ({ label: r.name, value: r.slug }))}
                          value={u.roleSlug}
                          disabled={busy || lastCeoManager}
                          onChange={(value) => runAction(u.id, () => onSetUserRole(u.id, value ?? u.roleSlug))}
                          searchable={false}
                          cleanable={false}
                          size="sm"
                        />
                      </span></>,
      <><span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATUS_STYLE[u.status]}`}>
                        {t(`userStatus.${u.status}`, { defaultValue: u.status })}
                      </span></>,
      <><div className="flex items-center justify-center gap-2">
                        {userScopeShape && userScopeShape !== 'tenant' && (
                          <button
                            onClick={() => setAccessUser(u)}
                            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                            title={userScopeShape === 'plant' ? t('clientUsers.editSites') : t('clientUsers.editMachines')}
                          >
                            <MapPin className="w-4 h-4" />
                          </button>
                        )}
                        {u.status === 'invited' && (
                          <button
                            onClick={() => runAction(u.id, async () => setReissued(await apiResendUserInvitation(u.id)))}
                            disabled={busy}
                            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 disabled:opacity-30 transition-colors cursor-pointer"
                            title={t('clientUsers.resend')}
                          >
                            <RotateCw className="w-4 h-4" />
                          </button>
                        )}
                        {u.status !== 'active' && !superAdmin && (
                          <button
                            onClick={() => {
                              if (window.confirm(t('clientUsers.deleteConfirm', { name: u.fullName }))) {
                                runAction(u.id, () => onDeleteUser(u.id));
                              }
                            }}
                            disabled={busy}
                            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 disabled:opacity-30 transition-colors cursor-pointer"
                            title={t('clientUsers.deleteTitle')}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                        {u.status === 'suspended' ? (
                          <button
                            onClick={() => runAction(u.id, () => onReinstateUser(u.id))}
                            disabled={busy}
                            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-emerald-600 hover:border-emerald-300 disabled:opacity-30 transition-colors cursor-pointer"
                            title={t('common.reinstate')}
                          >
                            <RotateCcw className="w-4 h-4" />
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              const reason = window.prompt(t('clientUsers.suspendPrompt', { name: u.fullName }));
                              if (reason) runAction(u.id, () => onSuspendUser(u.id, reason));
                            }}
                            disabled={busy || superAdmin}
                            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                            title={superAdmin ? t('clientUsers.cantSuspendSuperAdmin') : t('common.suspend')}
                          >
                            <Ban className="w-4 h-4" />
                          </button>
                        )}
                      </div></>,
    ];
  };

  return (
    <div id="client-user-management-view" className="space-y-3">
      <InvitationTokenDialog result={reissued} onClose={() => setReissued(null)} />
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 w-full max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            value={searchTerm}
            onChange={(value) => setSearchTerm(value)}
            placeholder={t('clientUsers.searchPlaceholder')}
            className="pl-9!"
            size="sm"
          />
        </div>
        <div className="flex items-center gap-3 w-full sm:w-auto">
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        <button
          onClick={() => setIsModalOpen(true)}
          className="w-full sm:w-auto px-5 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t('invite.title')}</span>
        </button>
        </div>
      </div>

      {(error || actionError) && (
        <div className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error || actionError}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        {filteredUsers.length === 0 ? (
          <div className="py-10 flex flex-col items-center gap-2 text-slate-400 text-sm"><div className="flex flex-col items-center gap-2 text-slate-400 text-sm">
                      <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
                      <span>{t('clientUsers.empty')}</span>
                    </div></div>
        ) : viewMode === 'list' ? (
          <ListTable bare columns={viewColumns} rows={pagedRows} rowKey={(u) => String(u.id)} cells={viewCells} />
        ) : (
          <div className="p-4"><RecordCards columns={viewColumns} rows={pagedRows} rowKey={(u) => String(u.id)} cells={viewCells} actionsIndex={4} /></div>
        )}
        {filteredUsers.length > 0 && <TablePagination pinToBottom {...pager} />}
      </div>

      <InviteUserModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onInvite={onInviteUser}
        roles={roles}
      />

      <EditUserAccessModal
        isOpen={!!accessUser}
        onClose={() => setAccessUser(null)}
        user={accessUser}
        roles={roles}
        plants={plants}
        equipment={equipment}
        onSetAccess={onSetUserAccess}
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
  const { t } = useTranslation('users');

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
      setError(err instanceof ApiError ? err.message : t('invite.failed'));
    } finally {
      setBusy(false);
    }
  };

  const handleCopyToken = () => {
    if (!invited?.invitationToken) return;
    copyToClipboard(invited.invitationToken).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    });
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">
            {invited ? t('invite.sent') : t('invite.title')}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {invited ? (
          <div className="p-6 space-y-4 text-sm">
            <p className="text-slate-600 dark:text-slate-300">
              <Trans i18nKey="invite.canAccept" t={t} values={{ name: invited.fullName }} components={{ b: <strong className="text-slate-900 dark:text-white" /> }} />
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">{t('invite.token')}</label>
              <div className="relative">
                <Input readOnly value={invited.invitationToken ?? ''} className="pr-9 font-mono" />
                <button type="button" onClick={handleCopyToken} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer" title={t('invite.copyToken')}>
                  {copied ? <CheckCheck className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              {invited.invitationExpiresAt && (
                <p className="text-xs text-slate-400 mt-1">
                  {t('invite.expires', { date: new Date(invited.invitationExpiresAt).toLocaleString() })}
                </p>
              )}
            </div>
            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-end">
              <button onClick={onClose} className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs transition-colors cursor-pointer">
                {t('common.done')}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">{t('invite.fullName')} <span className="text-rose-500">*</span></label>
              <Input
                required
                autoFocus
                value={fullName}
                onChange={(value) => setFullName(value)}
                placeholder={t('common.eg', { example: 'Priya Sharma' })}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">{t('col.email')} <span className="text-rose-500">*</span></label>
              <Input
                type="email"
                required
                value={email}
                onChange={(value) => setEmail(value)}
                placeholder={t('common.eg', { example: 'priya.sharma@example.com' })}
              />
              <p className="text-xs text-slate-400 mt-1">{t('invite.emailHint')}</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">{t('invite.phone')}</label>
              <Input
                type="tel"
                value={phone}
                onChange={(value) => setPhone(value)}
                placeholder={t('common.eg', { example: '+91 98100 22341' })}
                className="font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">{t('col.role')} <span className="text-rose-500">*</span></label>
              <SelectPicker
                data={roles.map((r) => ({ label: r.name, value: r.slug }))}
                value={roleSlug}
                onChange={(value) => setRoleSlug(value ?? '')}
                block
                searchable={false}
                cleanable={false}
              />
            </div>

            {error && (
              <div className="text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">{error}</div>
            )}

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
              <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer">
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={busy} className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed">
                <Check className="w-4 h-4" />
                <span>{busy ? t('invite.inviting') : t('invite.send')}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
