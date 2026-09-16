import React, { useState } from 'react';
import { Network, AlertCircle, Info, MailCheck } from 'lucide-react';
import { PasswordField } from '../common/PasswordField';

interface LoginScreenProps {
  // Master Admin still resolves locally (see App.tsx); anything else is a
  // real call to the API, hence the Promise — the form needs to know when
  // it's still in flight and what came back.
  onLogin: (identifier: string, password: string) => Promise<void>;
  error?: string;
  onWantAcceptInvitation: () => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin, error, onWantAcceptInvitation }) => {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showHints, setShowHints] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Trim both — copy/pasting a generated password (or the combined
    // "Username: ...\nPassword: ..." clipboard text) easily picks up a
    // stray leading/trailing space or newline that silently breaks the
    // exact-match comparison otherwise.
    setBusy(true);
    try {
      await onLogin(identifier.trim(), password.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="login-screen" className="min-h-screen w-full flex items-center justify-center bg-[#F4F7FB] dark:bg-slate-950 p-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-center text-[#00A4BD] mb-3">
            <Network className="w-7 h-7 stroke-[2.2]" />
          </div>
          <span className="text-xl font-semibold tracking-tight text-slate-800 dark:text-slate-100">
            Things<span className="font-normal text-slate-700 dark:text-slate-300">Alive</span>
          </span>
          <span className="text-xs text-slate-400 dark:text-slate-500 mt-1">Telematics IoT OS</span>
        </div>

        {/* Card */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-6">
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">Sign in</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-5">
            Master Admin signs in with a username; everyone else signs in with their email.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Username or email
              </label>
              <input
                type="text"
                required
                autoFocus
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="you@yourcompany.com"
                className="w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
              />
            </div>

            <PasswordField
              label="Password"
              value={password}
              onChange={setPassword}
              placeholder="••••••••"
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
              className="w-full py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {busy ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        </div>

        <button
          type="button"
          onClick={onWantAcceptInvitation}
          className="mt-4 w-full flex items-center justify-center gap-1.5 text-xs text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 cursor-pointer"
        >
          <MailCheck className="w-3.5 h-3.5" />
          <span>Have an invitation token? Set your password</span>
        </button>

        {/* Master Admin is now a real, stored platform_user credential (see
            src/identity/services/platform-credential.service.ts) — created
            via `npm run create:platform-user`, not hardcoded. Every login on
            this screen, including this one, goes to the real API. */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowHints(!showHints)}
            className="w-full flex items-center justify-center gap-1.5 text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
          >
            <Info className="w-3.5 h-3.5" />
            <span>{showHints ? 'Hide' : 'Show'} sign-in notes</span>
          </button>
          {showHints && (
            <div className="mt-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3 text-[11px] text-slate-500 dark:text-slate-400 space-y-1.5 font-mono">
              <div><strong className="text-slate-700 dark:text-slate-300">Master Admin:</strong> support@thingsalive.io / Admin@2026!!</div>
              <div><strong className="text-slate-700 dark:text-slate-300">Everyone else:</strong> a real email + password from the API's own database</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
