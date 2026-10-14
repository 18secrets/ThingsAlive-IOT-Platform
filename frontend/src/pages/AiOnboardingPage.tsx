import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePageHeader } from '../lib/PageHeaderContext';
import { OnboardingProgress } from '../components/onboarding/OnboardingProgress';
import { AIOnboarding } from '../components/onboarding/AIOnboarding';

type View = 'list' | 'chat';

/**
 * The list is real onboarding progress per site (GET /onboarding/status), a site being
 * the "session" (QONBOARD-STATUS §2). The chat is still a front-end assistant: nothing in
 * the backend answers it, and the task that built the progress endpoint ruled one out.
 */
export const AiOnboardingPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // AdminPage's "AI-assisted setup" link and Devices' "Setup with AI" both
  // land here wanting the chat open immediately, rather than the list.
  const [view, setView] = useState<View>(searchParams.get('start') === 'chat' ? 'chat' : 'list');

  usePageHeader(
    view === 'chat'
      ? { title: 'ChatBot Assistant', subtitle: 'AI Setup Assistant', breadcrumb: 'AI Onboarding', aiIndicator: true, onBack: () => setView('list') }
      : { title: 'AI Onboarding', subtitle: 'Onboarding progress by site' },
  );

  if (view === 'chat') {
    return <AIOnboarding onSkipToManualSetup={() => navigate('/admin/devices/new')} />;
  }
  return <OnboardingProgress onAddNew={() => setView('chat')} />;
};
