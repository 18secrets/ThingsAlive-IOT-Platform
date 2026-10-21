import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { usePageHeader } from '../lib/PageHeaderContext';
import { WorkflowDraft } from '../utils/workflowParser';
import { AlertAgentView } from '../components/views/AlertAgentView';
import { AlertAIAssistant } from '../components/alerts/AlertAIAssistant';
import { WorkflowEditor } from '../components/alerts/WorkflowEditor';

type View = 'list' | 'assistant' | 'workflow';

interface AlertAgentNavState {
  /** Set by Alerts' "Create alert with AI" button. */
  view?: 'assistant';
  /** Where this flow actually started — e.g. "/alerts", "/predictions", or a
   *  Thing detail page — and so where its back arrow should return, since
   *  neither flow passes through Alert Agent's own list. */
  backTo?: string;
}

export const AlertAgentPage: React.FC = () => {
  const { t } = useTranslation('alerts');
  const location = useLocation();
  const navigate = useNavigate();
  const navState = location.state as AlertAgentNavState | null;
  const backTo = navState?.backTo;
  const [view, setView] = useState<View>(navState?.view ?? 'list');
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowDraft | null>(null);

  usePageHeader(
    view === 'assistant'
      ? { title: t('agent.assistantTitle'), aiIndicator: true, onBack: backTo ? () => navigate(backTo) : () => setView('list') }
      : view === 'workflow'
        ? { title: t('agent.workflowTitle'), aiIndicator: true, onBack: backTo ? () => navigate(backTo) : () => setView('assistant') }
        : { title: t('translation:pages.alertAgent.title'), subtitle: t('translation:pages.alertAgent.subtitle') },
  );

  if (view === 'assistant') {
    return <AlertAIAssistant onGenerate={(draft) => { setActiveWorkflow(draft); setView('workflow'); }} />;
  }
  if (view === 'workflow' && activeWorkflow) {
    return (
      <WorkflowEditor
        draft={activeWorkflow}
        onDone={() => (backTo ? navigate(backTo) : setView('list'))}
      />
    );
  }
  return (
    <AlertAgentView
      onAddAlert={() => setView('assistant')}
      onOpen={(draft) => { setActiveWorkflow(draft); setView('workflow'); }}
    />
  );
};
