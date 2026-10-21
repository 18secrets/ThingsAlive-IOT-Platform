import React, { useMemo, useState } from 'react';
import { Search, Plus, ShieldCheck, AlertCircle, Mail, RotateCw, Trash2 } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import {
  ApiError, InvitePlatformStaffResult, PlatformStaffMember, PlatformStaffRole, ResendInvitationResult,
  apiResendPlatformStaffInvitation,
} from '../../lib/api';
import { InvitationTokenDialog } from '../common/InvitationTokenDialog';
import { InviteStaffModal } from './InviteStaffModal';

interface StaffManagementProps {
  staff: PlatformStaffMember[];
  error?: string;
  onInvite: (input: {
    email: string; fullName: string; role: PlatformStaffRole;
  }) => Promise<InvitePlatformStaffResult>;
  onSetRole: (id: string, role: PlatformStaffRole) => Promise<void>;
  onSuspend: (id: string, reason: string) => Promise<void>;
  onReinstate: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

// Labels are staff.role.<value> in the accounts namespace.
const ROLES: PlatformStaffRole[] = ['master-admin', 'platform-support', 'catalog-author'];

const STATUS_STYLE: Record<PlatformStaffMember['status'], string> = {
  invited: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  active: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  suspended: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
};

export const StaffManagement: React.FC<StaffManagementProps> = ({
  staff, error, onInvite, onSetRole, onSuspend, onReinstate, onDelete,
}) => {
  const { t } = useTranslation('accounts');
  const roleLabel = (r: PlatformStaffRole) => t(`staff.role.${r}`, { defaultValue: r });
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | PlatformStaffMember['status']>('all');
  const [roleFilter, setRoleFilter] = useState<'all' | PlatformStaffRole>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reissued, setReissued] = useState<ResendInvitationResult | null>(null);

  const filtered = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return staff.filter((s) =>
      (s.fullName.toLowerCase().includes(term) || s.email.toLowerCase().includes(term))
      && (statusFilter === 'all' || s.status === statusFilter)
      && (roleFilter === 'all' || s.role === roleFilter));
  }, [staff, searchTerm, statusFilter, roleFilter]);

  const handleRoleChange = async (id: string, role: PlatformStaffRole) => {
    setBusyId(id);
    try {
      await onSetRole(id, role);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('staff.roleFailed'));
    } finally {
      setBusyId(null);
    }
  };

  // Called directly rather than through a prop: nothing above this screen holds the
  // token, and it is shown once and then forgotten.
  const handleResend = async (member: PlatformStaffMember) => {
    setBusyId(member.id);
    try {
      setReissued(await apiResendPlatformStaffInvitation(member.id));
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('staff.resendFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (member: PlatformStaffMember) => {
    if (!window.confirm(t('staff.confirmDelete', { name: member.fullName }))) return;
    setBusyId(member.id);
    try {
      await onDelete(member.id);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('staff.deleteFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleStatus = async (member: PlatformStaffMember) => {
    if (member.status === 'suspended') {
      setBusyId(member.id);
      try {
        await onReinstate(member.id);
      } catch (err) {
        window.alert(err instanceof ApiError ? err.message : t('staff.reinstateFailed'));
      } finally {
        setBusyId(null);
      }
      return;
    }
    const reason = window.prompt(t('staff.suspendPrompt', { name: member.fullName }));
    if (!reason?.trim()) return;
    setBusyId(member.id);
    try {
      await onSuspend(member.id, reason.trim());
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('staff.suspendFailed'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div id="staff-management-view" className="space-y-3">

      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative flex-1 w-full max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            value={searchTerm}
            onChange={(value) => setSearchTerm(value)}
            placeholder={t('staff.searchPlaceholder')}
            className="pl-9!"
            size="sm"
          />
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <SelectPicker
            data={[{ label: t('staff.allStatuses'), value: 'all' }, { label: t('staff.status.invited'), value: 'invited' },
              { label: t('staff.status.active'), value: 'active' }, { label: t('staff.status.suspended'), value: 'suspended' }]}
            value={statusFilter}
            onChange={(v) => setStatusFilter((v ?? 'all') as typeof statusFilter)}
            searchable={false}
            cleanable={false}
            size="sm"
            className="w-full sm:w-40"
          />
          <SelectPicker
            data={[{ label: t('staff.allRoles'), value: 'all' },
              ...ROLES.map((r) => ({ label: roleLabel(r), value: r }))]}
            value={roleFilter}
            onChange={(v) => setRoleFilter((v ?? 'all') as typeof roleFilter)}
            searchable={false}
            cleanable={false}
            size="sm"
            className="w-full sm:w-44"
          />
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="w-full sm:w-auto px-5 py-2.5 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t('staff.invite')}</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((s) => (
          <div
            key={s.id}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex flex-col justify-between hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-3"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="w-8 h-8 rounded-full bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-4 h-4" />
                </div>
                <button
                  onClick={() => handleToggleStatus(s)}
                  disabled={busyId === s.id}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer disabled:opacity-50 ${
                    s.status !== 'suspended' ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'
                  }`}
                  title={s.status === 'suspended' ? t('staff.reinstate') : t('staff.suspend')}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      s.status !== 'suspended' ? 'translate-x-4.5' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
              <h4 className="font-semibold text-slate-900 dark:text-white text-base leading-snug truncate" title={s.fullName}>
                {s.fullName}
              </h4>
              <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-0.5 truncate">
                <Mail className="w-3 h-3 shrink-0" />
                <span className="truncate">{s.email}</span>
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-semibold text-slate-400 uppercase mb-1">{t('translation:settings.role')}</label>
              <SelectPicker
                data={ROLES.map((r) => ({ label: roleLabel(r), value: r }))}
                value={s.role}
                onChange={(value) => handleRoleChange(s.id, (value ?? s.role) as PlatformStaffRole)}
                disabled={busyId === s.id}
                block
                searchable={false}
                cleanable={false}
                size="sm"
              />
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs">
              <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATUS_STYLE[s.status]}`}>
                {t(`staff.status.${s.status}`, { defaultValue: s.status })}
              </span>
              {s.status === 'invited' && (
                <button
                  onClick={() => handleResend(s)}
                  disabled={busyId === s.id}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px] text-slate-500 hover:text-sky-600 hover:border-sky-300 disabled:opacity-50 transition-colors cursor-pointer"
                  title={t('staff.resendHint')}
                >
                  <RotateCw className={`w-3 h-3 ${busyId === s.id ? 'animate-spin' : ''}`} />
                  <span>{t('staff.resendInvitation')}</span>
                </button>
              )}
              {!s.activatedAt && (
                <button
                  onClick={() => handleDelete(s)}
                  disabled={busyId === s.id}
                  className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 disabled:opacity-30 transition-colors cursor-pointer"
                  title={t('staff.deleteHint')}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
              {s.suspendedReason && s.status === 'suspended' && (
                <span className="text-[10px] text-slate-400 truncate max-w-[140px]" title={s.suspendedReason}>
                  {s.suspendedReason}
                </span>
              )}
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
            <span>{t('staff.empty')}</span>
          </div>
        )}
      </div>

      <InvitationTokenDialog result={reissued} onClose={() => setReissued(null)} />

      <InviteStaffModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onInvite={onInvite}
      />
    </div>
  );
};
