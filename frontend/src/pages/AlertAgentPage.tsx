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
  // The list's starting filter: all, or the drafts when the assistant's "Explore more" opens it.
  const [listStart, setListStart] = useState({ status: 'All', search: '' });
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
        // A back arrow to Alerts, the page it is reached from (17 Nov): it has no sidebar entry.
        : { title: t('translation:pages.alertAgent.title'), subtitle: t('translation:pages.alertAgent.subtitle'), onBack: () => navigate(backTo ?? '/alerts') },
  );

  const editing = view === 'workflow' && activeWorkflow;
  // Kept mounted, only hidden, while its workflow is open, so coming back finds it as it was.
  const assistant = (view === 'assistant' || (editing && fromAssistant)) && (
    <div className={view === 'assistant' ? undefined : 'hidden'}>
      <AlertAIAssistant
        onGenerate={(draft) => { setActiveWorkflow(draft); setFromAssistant(true); setView('workflow'); }}
        onExploreDrafts={(search) => { setListStart({ status: 'Draft', search }); setView('list'); }}
        visible={view === 'assistant'}
      />
    </div>
  );
  if (view === 'assistant' || editing) {
    return (
      <>
        {assistant}
        {editing && (
          <WorkflowEditor
            draft={activeWorkflow}
            onDone={leaveAssistant}
            // Saved as a draft: to the drafts, with the one just saved found (testing sheet
            // TC_253). The editor stayed open with a one-line note, and the draft could
            // only be found again by going back and filtering the list by hand.
            onSaved={(name) => { setListStart({ status: 'Draft', search: name }); setView('list'); }}
          />
        )}
      </>
    );
  }
  return (
    <AlertAgentView
      // Keyed so the list takes the new starting filter each time it is opened this way.
      key={`${listStart.status}:${listStart.search}`}
      initialStatus={listStart.status}
      initialSearch={listStart.search}
      onAddAlert={() => { setListStart({ status: 'All', search: '' }); setView('assistant'); }}
      onOpen={(draft) => { setActiveWorkflow(draft); setFromAssistant(false); setView('workflow'); }}
    />
  );
};
