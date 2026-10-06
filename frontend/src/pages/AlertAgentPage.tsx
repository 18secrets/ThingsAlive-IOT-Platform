import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePageHeader } from '../lib/PageHeaderContext';
import { WorkflowSpec } from '../utils/workflowParser';
import { AlertAgentView } from '../components/views/AlertAgentView';
import { AlertAIAssistant } from '../components/alerts/AlertAIAssistant';
import { WorkflowEditor } from '../components/alerts/WorkflowEditor';

type View = 'list' | 'assistant' | 'workflow';

interface AlertAgentNavState {
  /** Set by Alerts' "Create alert with AI" button. */
  view?: 'assistant' | 'workflow';
  workflowSpec?: WorkflowSpec;
  /** Where this flow actually started — e.g. "/alerts", "/predictions", or a
   *  Thing detail page — and so where its back arrow should return, since
   *  neither flow passes through Alert Agent's own list. */
  backTo?: string;
}

export const AlertAgentPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const navState = location.state as AlertAgentNavState | null;
  const backTo = navState?.backTo;
  const [view, setView] = useState<View>(navState?.view ?? 'list');
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowSpec | null>(navState?.workflowSpec ?? null);

  usePageHeader(
    view === 'assistant'
      ? { title: 'AI Assistant', aiIndicator: true, onBack: backTo ? () => navigate(backTo) : () => setView('list') }
      : view === 'workflow'
        ? { title: 'Work Flow', aiIndicator: true, onBack: backTo ? () => navigate(backTo) : () => setView('assistant') }
        : { title: 'Alert Agent', subtitle: 'Automated Dispatch' },
  );

  if (view === 'assistant') {
    return <AlertAIAssistant onGenerate={(spec) => { setActiveWorkflow(spec); setView('workflow'); }} />;
  }
  if (view === 'workflow' && activeWorkflow) {
    return (
      <WorkflowEditor
        spec={activeWorkflow}
        onDeploy={() => (backTo ? navigate(backTo) : setView('list'))}
      />
    );
  }
  return <AlertAgentView onAddAlert={() => setView('assistant')} />;
};
