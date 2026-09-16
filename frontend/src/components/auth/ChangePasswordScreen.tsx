import React, { useState } from 'react';
import { Network, KeyRound, AlertCircle, CheckCircle2 } from 'lucide-react';
import { PasswordField } from '../common/PasswordField';

interface ChangePasswordScreenProps {
  displayName: string;
  currentPassword: string;
  onSubmit: (newPassword: string) => void;
}

export const ChangePasswordScreen: React.FC<ChangePasswordScreenProps> = ({ displayName, currentPassword, onSubmit }) => {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedNew = newPassword.trim();
    const trimmedConfirm = confirmPassword.trim();
    if (trimmedNew.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (trimmedNew === currentPassword.trim()) {
      setError('New password must be different from your temporary password.');
      return;
    }
    if (trimmedNew !== trimmedConfirm) {
      setError('Passwords do not match.');
      return;
    }
    setError(undefined);
    onSubmit(trimmedNew);
  };

  return (
    <div id="change-password-screen" className="min-h-screen w-full flex items-center justify-center bg-[#F4F7FB] dark:bg-slate-950 p-4">
      <div className="w-full max-w-sm">

        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-center text-[#00A4BD] mb-3">
            <Network className="w-7 h-7 stroke-[2.2]" />
          </div>
          <span className="text-xl font-semibold tracking-tight text-slate-800 dark:text-slate-100">
            Things<span className="font-normal text-slate-700 dark:text-slate-300">Alive</span>
          </span>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-6">
          <div className="w-9 h-9 rounded-lg bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center mb-3">
            <KeyRound className="w-4.5 h-4.5" />
          </div>
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">Set a new password</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-5">
            Welcome, <strong className="text-slate-700 dark:text-slate-300">{displayName}</strong>. For security, choose a new password before continuing.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <PasswordField
              label="New Password"
              value={newPassword}
              onChange={setNewPassword}
              placeholder="At least 8 characters"
              required
              autoFocus
            />

            <PasswordField
              label="Confirm Password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              placeholder="Re-enter new password"
              required
            />

            {error && (
              <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              className="w-full py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Update Password & Continue</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
