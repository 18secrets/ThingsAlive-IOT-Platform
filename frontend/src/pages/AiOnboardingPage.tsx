import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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

  if (view === 'chat') {
    return <AIOnboarding />;
  }
  return <OnboardingProgress onAddNew={() => setView('chat')} />;
};
