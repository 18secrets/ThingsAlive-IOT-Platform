import React, { useState, useRef, useEffect } from 'react';
import { Send, Sparkles, Boxes, MessageCircleQuestion, BellRing, FileBarChart } from 'lucide-react';
import { Input } from 'rsuite';
import { useTranslation } from 'react-i18next';
import {
  ApiError, AssistantMessage, AssistantProposal, apiAssistantOnboardingChat, apiConfirmAssistantProposal,
  apiListAssistantProposals, apiRejectAssistantProposal,
} from '../../lib/api';
import { ChatMarkdown } from '../common/ChatMarkdown';
import { OnboardingFocus, OnboardingStatusPanel } from './OnboardingStatusPanel';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Set on notes the screen writes itself (errors, the pending list). They re-render in
   *  the reader's language and are never sent back as something the assistant said. */
  key?: string;
  error?: boolean;
  /** Ids into the proposal map: changes the assistant proposed in this answer. */
  proposalIds?: string[];
}

// The server takes at most 20 messages of up to 2,000 characters each.
const MAX_SENT = 20;
const MAX_CHARS = 2000;

function errorKey(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 503) return 'chat.error.notConfigured';
    if (err.status === 403) return 'chat.error.forbidden';
    if (err.status === 429) return 'chat.error.allowanceUsed';
  }
  return 'chat.error.generic';
}

interface AIOnboardingProps {
  onSkipToManualSetup: () => void;
}

// Title, description and prompt are onboarding.json's chat.quick.<id>.*.
const QUICK_CARDS: { id: string; icon: React.FC<{ className?: string }> }[] = [
  { id: 'assets', icon: Boxes },
  { id: 'ask', icon: MessageCircleQuestion },
  { id: 'alerts', icon: BellRing },
  { id: 'reports', icon: FileBarChart },
];

// The assistant's lookups and proposals that make a conversation about setting things up;
// the first answer that uses one brings the Setup Status panel in.
const ONBOARDING_TOOLS = new Set([
  'onboarding_status', 'machine_onboarding', 'list_sites', 'my_loggers', 'list_equipment', 'logger_health',
  'propose_create_site', 'propose_create_equipment', 'propose_fit_logger',
]);

/** The machine an applied proposal worked on, so the panel can follow it. */
function focusOf(p: AssistantProposal): OnboardingFocus | null {
  if (p.status !== 'applied') return null;
  const result = p.result ?? {};
  if (p.kind === 'create_equipment' && typeof result.sourceSystem === 'string' && typeof result.code === 'string') {
    return { sourceSystem: result.sourceSystem, externalId: result.code };
  }
  if (p.kind === 'fit_logger' && typeof p.payload.sourceSystem === 'string' && typeof p.payload.equipmentCode === 'string') {
    return { sourceSystem: p.payload.sourceSystem, externalId: p.payload.equipmentCode };
  }
  return null;
}

export const AIOnboarding: React.FC<AIOnboardingProps> = ({ onSkipToManualSetup }) => {
  const { t } = useTranslation('onboarding');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Hidden until the conversation is about setup; then re-read after each answer and
  // each confirmed proposal, following the machine one just worked on.
  const [showStatus, setShowStatus] = useState(false);
  const [statusFocus, setStatusFocus] = useState<OnboardingFocus | null>(null);
  const [statusTick, setStatusTick] = useState(0);
  const [draft, setDraft] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  // One map, so a proposal decided in one bubble shows decided wherever it appears.
  const [proposals, setProposals] = useState<Record<string, AssistantProposal>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasStarted = messages.length > 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isThinking]);

  const remember = (list: AssistantProposal[]) =>
    setProposals((prev) => ({ ...prev, ...Object.fromEntries(list.map((p) => [p.id, p])) }));

  // A proposal outlives the chat that made it (it waits up to its expiry), so the ones
  // still open are shown when the chat opens, rather than only in the browser that asked.
  useEffect(() => {
    apiListAssistantProposals('proposed')
      .then((open) => {
        if (!open.length) return;
        remember(open);
        // Replaces rather than adds: StrictMode runs this effect twice in development.
        setMessages((prev) => [
          { id: 'pending', role: 'assistant', text: '', key: 'chat.proposal.pendingIntro', proposalIds: open.map((p) => p.id) },
          ...prev.filter((m) => m.id !== 'pending'),
        ]);
      })
      .catch(() => undefined);
  }, []);

  const sendMessage = async (text: string) => {
    const trimmed = text.trim().slice(0, MAX_CHARS);
    if (!trimmed || isThinking) return;

    // A question whose answer failed is left out, or the next request would carry two
    // questions in a row with nothing between them.
    const history: AssistantMessage[] = [...messages, { id: 'next', role: 'user' as const, text: trimmed }]
      .filter((m, i, all) => !m.key && m.text && !all[i + 1]?.error)
      .map((m) => ({ role: m.role, text: m.text.slice(0, MAX_CHARS) }))
      .slice(-MAX_SENT);

    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', text: trimmed }]);
    setDraft('');
    setIsThinking(true);
    try {
      const answer = await apiAssistantOnboardingChat(history);
      remember(answer.proposals);
      if (answer.proposals.length || answer.toolsUsed.some((tool) => ONBOARDING_TOOLS.has(tool))) {
        setShowStatus(true);
        setStatusTick((n) => n + 1);
      }
      setMessages((prev) => [...prev, {
        id: `a-${Date.now()}`, role: 'assistant', text: answer.reply, proposalIds: answer.proposals.map((p) => p.id),
      }]);
    } catch (err) {
      setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: 'assistant', text: '', key: errorKey(err), error: true }]);
    } finally {
      setIsThinking(false);
    }
  };

  const decided = (p: AssistantProposal) => {
    remember([p]);
    if (p.status !== 'applied') return;
    setShowStatus(true);
    const focus = focusOf(p);
    if (focus) setStatusFocus(focus);
    setStatusTick((n) => n + 1);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(draft);
  };

  return (
    // Height-locked to the viewport (minus the header + page padding above
    // it) so this component owns its own scrolling instead of the page:
    // the chat column below splits into a scrollable history and a input
    // bar that stays put in normal flow, never inside the scrollable part.
    <div id="ai-onboarding-view" className="flex items-start gap-6 h-[calc(100vh-5rem)]" data-purpose="ai-onboarding-page">

      {/* Main Chat Column */}
      <div className="flex-1 min-w-0 max-w-3xl mx-auto flex flex-col h-full min-h-0">

        {/* Scrollable: intro, chat thread, quick cards */}
        <div className="flex-1 min-h-0 overflow-y-auto pr-1">
          {!hasStarted && (
            <div className="text-center mb-6">
              <h2 className="text-2xl font-semibold text-slate-800 dark:text-slate-100">
                {t('chat.heading')}
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5">
                {t('chat.intro')}
              </p>
            </div>
          )}

          {/* Chat Thread */}
          <div className="space-y-4 mb-5">
            {messages.map((msg) => (
              msg.role === 'user' ? (
                <div key={msg.id} className="flex justify-end">
                  <div className="max-w-md bg-sky-700 dark:bg-sky-800 text-white rounded-2xl rounded-br-md px-4 py-3 text-sm shadow-xs">
                    {msg.text}
                  </div>
                </div>
              ) : (
                <div key={msg.id} className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-sky-600 text-white flex items-center justify-center shrink-0 mt-0.5">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div className={`max-w-md border rounded-2xl rounded-tl-md px-4 py-3 shadow-xs ${
                    msg.error
                      ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/50'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800'
                  }`}>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-sky-600 dark:text-sky-400 mb-1">
                      {t('chat.assistantName')}
                    </div>
                    <div className={`text-sm leading-relaxed ${msg.error ? 'text-amber-800 dark:text-amber-200' : 'text-slate-700 dark:text-slate-200'}`}>
                      {msg.key ? t(msg.key) : <ChatMarkdown text={msg.text} />}
                    </div>
                    {msg.proposalIds && msg.proposalIds.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {msg.proposalIds.map((id) => proposals[id] && (
                          <ProposalCard key={id} proposal={proposals[id]} onDecided={decided} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            ))}

            {isThinking && (
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-sky-600 text-white flex items-center justify-center shrink-0 mt-0.5">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl rounded-tl-md px-4 py-3 shadow-xs flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600 animate-bounce [animation-delay:-0.3s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600 animate-bounce [animation-delay:-0.15s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600 animate-bounce" />
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Quick Action Cards — only before the conversation starts, same
              as the intro heading above. */}
          {!hasStarted && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {QUICK_CARDS.map((card) => {
                const Icon = card.icon;
                return (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => sendMessage(t(`chat.quick.${card.id}.prompt`))}
                    disabled={isThinking}
                    className="text-left p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs hover:border-sky-300 dark:hover:border-sky-700 hover:shadow-sm transition-all cursor-pointer"
                  >
                    <Icon className="w-4 h-4 text-sky-600 dark:text-sky-400 mb-2" />
                    <div className="font-semibold text-sm text-slate-800 dark:text-slate-100">
                      {t(`chat.quick.${card.id}.title`)}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {t(`chat.quick.${card.id}.description`)}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Message Input — outside the scrollable area above, in normal
            flow at the bottom of this height-locked column, so it never
            scrolls out of view regardless of how long the chat gets. */}
        <div className="shrink-0 pt-4">
          <form onSubmit={handleSubmit} className="flex items-center gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-full shadow-xs pl-4 pr-1.5 py-1.5">
            <Input
              value={draft}
              onChange={(value) => setDraft(value)}
              placeholder={t('chat.placeholder')}
              maxLength={MAX_CHARS}
              className="flex-1 bg-transparent border-none! shadow-none! outline-none!"
            />
            <button
              type="submit"
              disabled={!draft.trim() || isThinking}
              className="w-9 h-9 rounded-full bg-sky-700 hover:bg-sky-800 disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors cursor-pointer shrink-0"
              title={t('chat.send')}
            >
              <Send className="w-4 h-4" />
            </button>
          </form>

          <button
            type="button"
            onClick={onSkipToManualSetup}
            className="block text-center text-xs text-slate-500 dark:text-slate-400 underline hover:text-slate-700 dark:hover:text-slate-200 transition-colors cursor-pointer mt-3 mx-auto"
          >
            {t('chat.manualSetup')}
          </button>
        </div>
      </div>

      {/* Setup Status Panel — only once the conversation is about setting things up */}
      {showStatus && (
        <div className="w-96 shrink-0 hidden lg:block h-full overflow-y-auto">
          <OnboardingStatusPanel focus={statusFocus} refreshKey={statusTick} onClearFocus={() => setStatusFocus(null)} />
        </div>
      )}

    </div>
  );
};

const PROPOSAL_STATUS_STYLES: Record<AssistantProposal['status'], string> = {
  proposed: 'text-sky-700 dark:text-sky-300',
  applied: 'text-emerald-700 dark:text-emerald-300',
  failed: 'text-rose-700 dark:text-rose-300',
  rejected: 'text-slate-500 dark:text-slate-400',
  expired: 'text-slate-500 dark:text-slate-400',
};

/**
 * One change the assistant proposed. Nothing happens until the person confirms it, and
 * then it runs as them, through the same service the manual screens use; the server
 * decides each proposal once, so a second click returns the first decision.
 */
const ProposalCard: React.FC<{ proposal: AssistantProposal; onDecided: (p: AssistantProposal) => void }> = ({ proposal, onDecided }) => {
  const { t } = useTranslation('onboarding');
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (how: 'confirm' | 'reject') => {
    setBusy(how);
    setError(null);
    try {
      onDecided(await (how === 'confirm' ? apiConfirmAssistantProposal(proposal.id) : apiRejectAssistantProposal(proposal.id)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('chat.error.generic'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {t(`chat.proposal.kind.${proposal.kind}`)}
        </span>
        <span className={`text-[10px] font-bold uppercase tracking-wider ${PROPOSAL_STATUS_STYLES[proposal.status]}`}>
          {t(`chat.proposal.status.${proposal.status}`)}
        </span>
      </div>
      <p className="text-sm text-slate-800 dark:text-slate-100">{proposal.summary}</p>
      {proposal.error && <p className="text-xs text-rose-600 dark:text-rose-400">{proposal.error}</p>}
      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      {proposal.status === 'proposed' && (
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={() => decide('confirm')}
            disabled={busy !== null}
            className="px-3 py-1.5 bg-sky-700 hover:bg-sky-800 disabled:opacity-40 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer"
          >
            {busy === 'confirm' ? t('chat.proposal.working') : t('chat.proposal.confirm')}
          </button>
          <button
            type="button"
            onClick={() => decide('reject')}
            disabled={busy !== null}
            className="px-3 py-1.5 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-900 disabled:opacity-40 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
          >
            {t('chat.proposal.reject')}
          </button>
        </div>
      )}
    </div>
  );
};
