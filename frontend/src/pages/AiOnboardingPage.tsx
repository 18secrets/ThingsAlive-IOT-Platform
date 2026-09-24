import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { OnboardingSessionItem } from '../types';
import { usePageHeader } from '../lib/PageHeaderContext';
import { OnboardingList } from '../components/onboarding/OnboardingList';
import { EquipmentDetailsView } from '../components/onboarding/EquipmentDetailsView';
import { AIOnboarding } from '../components/onboarding/AIOnboarding';

interface AiOnboardingPageProps {
  sessions: OnboardingSessionItem[];
  onToggleActive: (id: string) => void;
  onRefreshSession: (id: string) => void;
}

type View = 'list' | 'chat' | 'equipment-detail';

export const AiOnboardingPage: React.FC<AiOnboardingPageProps> = ({ sessions, onToggleActive, onRefreshSession }) => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // AdminPage's "AI-assisted setup" link and Devices' "Setup with AI" both
  // land here wanting the chat open immediately, rather than the list.
  const [view, setView] = useState<View>(searchParams.get('start') === 'chat' ? 'chat' : 'list');

  usePageHeader(
    view === 'chat'
      ? { title: 'ChatBot Assistant', subtitle: 'AI Setup Assistant', breadcrumb: 'AI Onboarding', aiIndicator: true, onBack: () => setView('list') }
      : view === 'equipment-detail'
        ? { title: 'Equipment Details', breadcrumb: 'AI Onboarding', onBack: () => setView('list') }
        : { title: 'AI Onboarding', subtitle: 'Guided Setup Sessions' },
  );

  if (view === 'equipment-detail') return <EquipmentDetailsView />;
  if (view === 'chat') {
    return <AIOnboarding onSkipToManualSetup={() => navigate('/admin/devices/new')} />;
  }
  return (
    <OnboardingList
      sessions={sessions}
      onAddNew={() => setView('chat')}
      onViewSession={() => setView('equipment-detail')}
      onEditSession={() => setView('chat')}
      onToggleActive={onToggleActive}
      onRefreshSession={onRefreshSession}
    />
  );
};
