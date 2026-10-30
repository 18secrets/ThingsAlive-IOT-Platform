import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { usePageHeader } from '../lib/PageHeaderContext';
import { OnboardingProgress } from '../components/onboarding/OnboardingProgress';
import { AIOnboarding } from '../components/onboarding/AIOnboarding';

type View = 'list' | 'chat';

/**
 * The list is real onboarding progress per site (GET /onboarding/status), a site being
 * the "session" (QONBOARD-STATUS §2). The chat is POST /assistant/onboarding/chat
 * (QCHAT1): it reads and proposes, and a proposal changes nothing until the person
 * confirms it.
 */
export const AiOnboardingPage: React.FC = () => {
  const { t } = useTranslation('onboarding');
  const [searchParams] = useSearchParams();
  // AdminPage's "AI-assisted setup" link and Devices' "Setup with AI" both
  // land here wanting the chat open immediately, rather than the list.
  const [view, setView] = useState<View>(searchParams.get('start') === 'chat' ? 'chat' : 'list');

  usePageHeader(
    view === 'chat'
      ? { title: t('page.chatTitle'), subtitle: t('page.chatSubtitle'), breadcrumb: t('page.title'), aiIndicator: true, onBack: () => setView('list') }
      : { title: t('page.title'), subtitle: t('page.subtitle') },
  );

  const navigate = useNavigate();
  if (view === 'chat') {
    // The chat is one way in, not the only one: "New AI Onboarding" offered no form, no
    // fields and no class picker (test report OB-7). The form route sits beside it.
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
          <span>{t('page.preferForm')}</span>
          <button type="button" onClick={() => navigate('/admin/equipment')} className="shrink-0 font-semibold text-sky-700 dark:text-sky-400 hover:underline cursor-pointer">
            {t('page.openForm')}
          </button>
        </div>
        <AIOnboarding />
      </div>
    );
  }
  return <OnboardingProgress onAddNew={() => setView('chat')} />;
};
