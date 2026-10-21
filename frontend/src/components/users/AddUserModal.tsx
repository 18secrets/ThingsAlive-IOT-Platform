import React, { useEffect, useState } from 'react';
import { X, Check } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { PlatformUserItem, PlatformUserRole } from '../../types';

interface AddUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (user: PlatformUserItem) => void;
  existingUsernames: string[];
  existingEmployeeIds: string[];
  nextId: number;
  existingUser?: PlatformUserItem | null;
}

const ROLES: PlatformUserRole[] = ['Operational', 'Executive', 'Support', 'Admin', 'Super Admin'];

export const AddUserModal: React.FC<AddUserModalProps> = ({
  isOpen,
  onClose,
  onSave,
  existingUsernames,
  existingEmployeeIds,
  nextId,
  existingUser,
}) => {
  const { t } = useTranslation('users');
  const [employeeId, setEmployeeId] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PlatformUserRole>('Operational');
  const [phone, setPhone] = useState('');
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  // Re-sync form fields whenever the modal opens, for either a fresh user
  // or a different existing one to edit.
  useEffect(() => {
    if (!isOpen) return;
    if (existingUser) {
      setEmployeeId(existingUser.employeeId);
      setUsername(existingUser.username);
      setEmail(existingUser.email);
      setRole(existingUser.role);
      setPhone(existingUser.phone);
      setActive(existingUser.active);
    } else {
      setEmployeeId('');
      setUsername('');
      setEmail('');
      setRole('Operational');
      setPhone('');
      setActive(true);
    }
    setError(undefined);
  }, [isOpen, existingUser]);

  if (!isOpen) return null;

  const isEditing = !!existingUser;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalEmployeeId = employeeId.trim();
    const finalUsername = username.trim();
    const finalEmail = email.trim();
    const finalPhone = phone.trim();

    if (!finalEmployeeId || !finalUsername || !finalEmail || !finalPhone) return;
    if (existingUsernames.includes(finalUsername.toLowerCase())) {
      setError(t('platformUsers.usernameTaken'));
      return;
    }
    if (existingEmployeeIds.includes(finalEmployeeId.toLowerCase())) {
      setError(t('platformUsers.employeeIdTaken'));
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(finalEmail)) {
      setError(t('platformUsers.invalidEmail'));
      return;
    }

    const user: PlatformUserItem = {
      id: isEditing ? existingUser!.id : nextId,
      employeeId: finalEmployeeId,
      username: finalUsername,
      email: finalEmail,
      role,
      phone: finalPhone,
      active,
    };

    onSave(user);
    onClose();
  };

  return (
    <div
      id="addUserModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">
            {isEditing ? t('platformUsers.edit') : t('platformUsers.add')}
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm max-h-[75vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('platformUsers.employeeId')} <span className="text-rose-500">*</span>
              </label>
              <Input
                required
                value={employeeId}
                onChange={(value) => { setEmployeeId(value); setError(undefined); }}
                placeholder={t('common.eg', { example: 'EMP0009' })}
                className="font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('col.username')} <span className="text-rose-500">*</span>
              </label>
              <Input
                required
                value={username}
                onChange={(value) => { setUsername(value); setError(undefined); }}
                placeholder={t('common.eg', { example: 'jsmith' })}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t('platformUsers.emailId')} <span className="text-rose-500">*</span>
            </label>
            <Input
              type="email"
              required
              value={email}
              onChange={(value) => { setEmail(value); setError(undefined); }}
              placeholder={t('common.eg', { example: 'jsmith@thingsalive.io' })}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('col.role')} <span className="text-rose-500">*</span>
              </label>
              <SelectPicker
                data={ROLES.map((r) => ({ label: t(`platformRole.${r}`, { defaultValue: r }), value: r }))}
                value={role}
                onChange={(value) => setRole((value ?? 'Operational') as PlatformUserRole)}
                block
                searchable={false}
                cleanable={false}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('platformUsers.phoneNo')} <span className="text-rose-500">*</span>
              </label>
              <Input
                type="tel"
                required
                value={phone}
                onChange={(value) => setPhone(value)}
                placeholder={t('common.eg', { example: '9898989898' })}
                className="font-mono"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="accent-sky-600 w-4 h-4 cursor-pointer"
            />
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{t('status.active')}</span>
          </label>

          {error && (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer"
            >
              <Check className="w-4 h-4" />
              <span>{isEditing ? t('common.saveChanges') : t('platformUsers.create')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
