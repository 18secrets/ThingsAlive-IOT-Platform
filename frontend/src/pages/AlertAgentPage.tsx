import React, { useState } from 'react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { WorkflowSpec } from '../utils/workflowParser';
import { AlertAgentView } from '../components/views/AlertAgentView';
import { AlertAIAssistant } from '../components/alerts/AlertAIAssistant';
import { WorkflowEditor } from '../components/alerts/WorkflowEditor';

type View = 'list' | 'assistant' | 'workflow';

export const AlertAgentPage: React.FC = () => {
  const [view, setView] = useState<View>('list');
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowSpec | null>(null);

  usePageHeader(
    view === 'assistant'
      ? { title: 'AI Assistant', aiIndicator: true, onBack: () => setView('list') }
      : view === 'workflow'
        ? { title: 'Work Flow', aiIndicator: true, onBack: () => setView('assistant') }
        : { title: 'Alert Agent', subtitle: 'Automated Dispatch' },
  );

  if (view === 'assistant') {
    return <AlertAIAssistant onGenerate={(spec) => { setActiveWorkflow(spec); setView('workflow'); }} />;
  }
  if (view === 'workflow' && activeWorkflow) {
    return (
      <WorkflowEditor
        spec={activeWorkflow}
        onBack={() => setView('assistant')}
        onDeploy={() => setView('list')}
      />
    );
  }
  return <AlertAgentView onAddAlert={() => setView('assistant')} />;
};
