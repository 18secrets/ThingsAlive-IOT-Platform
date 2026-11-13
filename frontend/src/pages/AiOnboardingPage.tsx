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
    // fields and no class picker (test report OB-7). The form route sits under the input:
    // above the chat it pushed the input below the fold, so it showed only on scrolling.
    return (
      <AIOnboarding
        footer={(
          <p className="mt-2 px-4 text-xs text-slate-500 dark:text-slate-400">
            {t('page.preferForm')}{' '}
            <button type="button" onClick={() => navigate('/admin/equipment')} className="font-semibold text-sky-700 dark:text-sky-400 hover:underline cursor-pointer">
              {t('page.openForm')}
            </button>
          </p>
        )}
      />
    );
  }
  return <OnboardingProgress onAddNew={() => setView('chat')} />;
};
