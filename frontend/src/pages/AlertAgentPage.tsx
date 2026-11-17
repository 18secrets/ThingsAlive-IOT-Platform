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
  // Whether the open workflow came from the assistant: its back arrow then returns to the
  // assistant with the class, failure mode and prompt still filled in (testing sheet
  // TC_189). It went to where the flow began, and the assistant had been unmounted, so
  // everything typed was lost.
  const [fromAssistant, setFromAssistant] = useState(false);
  const leaveAssistant = () => (backTo ? navigate(backTo) : setView('list'));

  usePageHeader(
    view === 'assistant'
      ? { title: t('agent.assistantTitle'), aiIndicator: true, onBack: leaveAssistant }
      : view === 'workflow'
        ? { title: t('agent.workflowTitle'), aiIndicator: true, onBack: fromAssistant ? () => setView('assistant') : leaveAssistant }
        : { title: t('translation:pages.alertAgent.title'), subtitle: t('translation:pages.alertAgent.subtitle') },
  );

  const editing = view === 'workflow' && activeWorkflow;
  // Kept mounted, only hidden, while its workflow is open, so coming back finds it as it was.
  const assistant = (view === 'assistant' || (editing && fromAssistant)) && (
    <div className={view === 'assistant' ? undefined : 'hidden'}>
      <AlertAIAssistant onGenerate={(draft) => { setActiveWorkflow(draft); setFromAssistant(true); setView('workflow'); }} />
    </div>
  );
  if (view === 'assistant' || editing) {
    return (
      <>
        {assistant}
        {editing && <WorkflowEditor draft={activeWorkflow} onDone={leaveAssistant} />}
      </>
    );
  }
  return (
    <AlertAgentView
      onAddAlert={() => setView('assistant')}
      onOpen={(draft) => { setActiveWorkflow(draft); setFromAssistant(false); setView('workflow'); }}
    />
  );
};
