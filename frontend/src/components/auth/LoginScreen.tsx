import React, { useState } from 'react';
import { Network, Eye, EyeOff, AlertCircle, Info } from 'lucide-react';

interface LoginScreenProps {
  onLogin: (username: string, password: string) => void;
  error?: string;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin, error }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showHints, setShowHints] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Trim both — copy/pasting a generated password (or the combined
    // "Username: ...\nPassword: ..." clipboard text) easily picks up a
    // stray leading/trailing space or newline that silently breaks the
    // exact-match comparison otherwise.
    onLogin(username.trim(), password.trim());
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
            Enter your username and password to access your workspace.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Username
              </label>
              <input
                type="text"
                required
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. acme.cement"
                className="w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-3 py-2 pr-10 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              className="w-full py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-semibold shadow-xs transition-colors cursor-pointer"
            >
              Sign In
            </button>
          </form>
        </div>

        {/* Demo credential hint — this project has no backend yet, so these are the only logins */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowHints(!showHints)}
            className="w-full flex items-center justify-center gap-1.5 text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
          >
            <Info className="w-3.5 h-3.5" />
            <span>{showHints ? 'Hide' : 'Show'} demo credentials</span>
          </button>
          {showHints && (
            <div className="mt-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3 text-[11px] text-slate-500 dark:text-slate-400 space-y-1.5 font-mono">
              <div><strong className="text-slate-700 dark:text-slate-300">Master Admin:</strong> thingsalive.admin / Admin@123</div>
              <div><strong className="text-slate-700 dark:text-slate-300">Client (first login):</strong> cemindia / Welcome@123</div>
              <div><strong className="text-slate-700 dark:text-slate-300">Client (existing):</strong> beml / BEML#2026</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
