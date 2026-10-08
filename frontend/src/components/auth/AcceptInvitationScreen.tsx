import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { KeyRound, AlertCircle, CheckCircle2, ArrowLeft } from 'lucide-react';
import { Input } from 'rsuite';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/AuthProvider';
import { PasswordField } from '../common/PasswordField';
import logoFull from '../../../assets/logo-icon.png';

export const AcceptInvitationScreen: React.FC = () => {
  const { acceptInvitation } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialToken = searchParams.get('invite') ?? undefined;

  const [token, setToken] = useState(initialToken ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedToken = token.trim();
    const trimmedNew = password.trim();
    if (!/[A-Z]/.test(trimmedNew) || !/[a-z]/.test(trimmedNew) || !/[0-9]/.test(trimmedNew) || !/[^A-Za-z0-9]/.test(trimmedNew)) {
      setError('Password needs an uppercase letter, a lowercase letter, a number and a special character.');
      return;
    }
    if (trimmedNew !== confirmPassword.trim()) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await acceptInvitation(trimmedToken, trimmedNew);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not accept the invitation.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="accept-invitation-screen" className="min-h-screen w-full flex items-center justify-center bg-[#F4F7FB] dark:bg-slate-950 p-4">
      <div className="w-full max-w-sm">

        <div className="flex flex-col items-center mb-8">
          <img src={logoFull} alt="ThingsAlive" className="h-14 w-auto object-contain" />
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-6">
          <div className="w-9 h-9 rounded-lg bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center mb-3">
            <KeyRound className="w-4.5 h-4.5" />
          </div>
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">Accept your invitation</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-5">
            Paste the invitation token Things Alive gave you, then choose a password. This is the only time
            you'll need the token — after this you sign in with just your email.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Invitation Token
              </label>
              <Input
                required
                autoFocus={!initialToken}
                value={token}
                onChange={(value) => setToken(value)}
                placeholder="Paste the token here"
                className="font-mono"
              />
            </div>

            <PasswordField
              label="New Password"
              value={password}
              onChange={setPassword}
              placeholder="Aa1! and at least 8 characters"
              required
              autoFocus={!!initialToken}
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
              disabled={busy}
              className="w-full py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{busy ? 'Setting password…' : 'Set Password & Sign In'}</span>
            </button>
          </form>
        </div>

        <button
          type="button"
          onClick={() => navigate('/sign-in')}
          className="mt-4 w-full flex items-center justify-center gap-1.5 text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to sign in</span>
        </button>
      </div>
    </div>
  );
};
