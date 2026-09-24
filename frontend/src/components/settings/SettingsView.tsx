import React, { useMemo, useState } from 'react';
import {
  UserCircle2,
  ShieldCheck,
  Briefcase,
  Calendar,
  KeyRound,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import { AuthUser, ClientAccount } from '../../types';
import { PasswordField } from '../common/PasswordField';

interface SettingsViewProps {
  authUser: AuthUser;
  clients: ClientAccount[];
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<string | null>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ authUser, clients, onChangePassword }) => {
  const isMasterAdmin = authUser.role === 'master-admin';

  // For a client, look up their live account record for status / created date
  const clientRecord = useMemo(() => {
    if (isMasterAdmin) return null;
    return clients.find((c) => c.id === authUser.clientId) || null;
  }, [clients, authUser.clientId, isMasterAdmin]);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [successMessage, setSuccessMessage] = useState<string | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuccessMessage(undefined);

    const trimmedCurrent = currentPassword.trim();
    const trimmedNew = newPassword.trim();
    const trimmedConfirm = confirmPassword.trim();

    if (trimmedNew.length < 8) {
      setFormError('New password must be at least 8 characters.');
      return;
    }
    if (trimmedNew === trimmedCurrent) {
      setFormError('New password must be different from your current password.');
      return;
    }
    if (trimmedNew !== trimmedConfirm) {
      setFormError('New password and confirmation do not match.');
      return;
    }

    setIsSubmitting(true);
    const error = await onChangePassword(trimmedCurrent, trimmedNew);
    setIsSubmitting(false);
    if (error) {
      setFormError(error);
      return;
    }

    setFormError(undefined);
    setSuccessMessage('Your password has been updated. Signing you out for a fresh sign-in…');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  const displayName = isMasterAdmin ? 'ThingsAlive Master Admin' : (authUser.clientName || authUser.username);
  const initial = displayName.trim().charAt(0).toUpperCase() || '?';

  return (
    <div id="settings-view" className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">Account Settings</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Manage your profile information and account security.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* Account Information Card */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-sky-600 text-white flex items-center justify-center font-semibold text-sm shrink-0">
              {initial}
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">{displayName}</div>
              <div className="text-xs text-slate-400">{authUser.username}</div>
            </div>
          </div>

          <div className="p-5 space-y-3.5 text-xs">
            <div className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/60">
              <span className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                <ShieldCheck className="w-3.5 h-3.5 text-sky-600" />
                Role
              </span>
              <span className="px-2 py-0.5 rounded bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 font-semibold border border-sky-200 dark:border-sky-800 text-[11px]">
                {isMasterAdmin ? 'ThingsAlive Master Admin' : 'Client'}
              </span>
            </div>

            <div className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/60">
              <span className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                <UserCircle2 className="w-3.5 h-3.5 text-sky-600" />
                Username
              </span>
              <span className="font-mono font-medium text-slate-700 dark:text-slate-200">{authUser.username}</span>
            </div>

            {!isMasterAdmin && (
              <div className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/60">
                <span className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                  <Briefcase className="w-3.5 h-3.5 text-sky-600" />
                  Client Organization
                </span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{authUser.clientName || '—'}</span>
              </div>
            )}

            <div className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/60">
              <span className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                <CheckCircle2 className="w-3.5 h-3.5 text-sky-600" />
                Account Status
              </span>
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                • {isMasterAdmin ? 'Active' : (clientRecord?.status || 'Active')}
              </span>
            </div>

            <div className="flex items-center justify-between py-1.5">
              <span className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                <Calendar className="w-3.5 h-3.5 text-sky-600" />
                {isMasterAdmin ? 'Access Level' : 'Client Since'}
              </span>
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {isMasterAdmin ? 'All Plants & Clients' : (clientRecord?.createdAt || '—')}
              </span>
            </div>
          </div>
        </div>

        {/* Change Password Card */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
              <KeyRound className="w-4 h-4" />
            </div>
            <div>
              <div className="font-semibold text-sm text-slate-800 dark:text-slate-100">Change Password</div>
              <div className="text-xs text-slate-400">Update the password used to sign in</div>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="p-5 space-y-3.5">
            <PasswordField
              label="Current Password"
              value={currentPassword}
              onChange={setCurrentPassword}
              placeholder="Enter your current password"
              required
            />

            <PasswordField
              label="New Password"
              value={newPassword}
              onChange={setNewPassword}
              placeholder="Upper, lower, number & symbol"
              required
            />

            <PasswordField
              label="Confirm New Password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              placeholder="Re-enter new password"
              required
            />

            {formError && (
              <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            {successMessage && (
              <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded-lg px-3 py-2">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>{successMessage}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-2.5 bg-sky-600 hover:bg-sky-700 active:bg-sky-800 disabled:opacity-60 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <KeyRound className="w-4 h-4" />
              <span>{isSubmitting ? 'Updating…' : 'Update Password'}</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
