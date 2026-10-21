import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { KeyRound, AlertCircle, MailCheck, ArrowLeft } from 'lucide-react';
import { Input } from 'rsuite';
import { ApiError, apiForgotPassword } from '../../lib/api';
import logoFull from '../../../assets/logo-icon.png';

export const ForgotPasswordScreen: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await apiForgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('forgot.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="forgot-password-screen" className="min-h-screen w-full flex items-center justify-center bg-[#F4F7FB] dark:bg-slate-950 p-4">
      <div className="w-full max-w-sm">

        <div className="flex flex-col items-center mb-8">
          <img src={logoFull} alt="ThingsAlive" className="h-14 w-auto object-contain" />
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-6">
          {sent ? (
            <>
              <div className="w-9 h-9 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-3">
                <MailCheck className="w-4.5 h-4.5" />
              </div>
              <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{t('forgot.sentTitle')}</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                <Trans i18nKey="forgot.sentBody" values={{ email: email.trim() }} components={{ 1: <span className="font-medium text-slate-700 dark:text-slate-300" /> }} />
              </p>
            </>
          ) : (
            <>
              <div className="w-9 h-9 rounded-lg bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center mb-3">
                <KeyRound className="w-4.5 h-4.5" />
              </div>
              <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{t('forgot.title')}</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-5">
                {t('forgot.intro')}
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t('common.email')}
                  </label>
                  <Input
                    required
                    autoFocus
                    type="email"
                    value={email}
                    onChange={(value) => setEmail(value)}
                    placeholder={t('forgot.emailPlaceholder')}
                  />
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busy || !email.trim()}
                  className="w-full py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {busy ? t('forgot.submitting') : t('forgot.submit')}
                </button>
              </form>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => navigate('/sign-in')}
          className="mt-4 w-full flex items-center justify-center gap-1.5 text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>{t('common.backToSignIn')}</span>
        </button>
      </div>
    </div>
  );
};
