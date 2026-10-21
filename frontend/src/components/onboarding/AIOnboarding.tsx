import React, { useState, useRef, useEffect } from 'react';
import { Send, Sparkles, ListChecks, Check, Boxes, MessageCircleQuestion, BellRing, FileBarChart } from 'lucide-react';
import { Input } from 'rsuite';
import { useTranslation } from 'react-i18next';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

type StatusState = 'done' | 'active' | 'pending';

// Labels are onboarding.json's chat.step.<id> (and chat.step.<id>Sub for a sublabel).
interface SetupStatusItem {
  id: string;
  hasSublabel?: boolean;
  status: StatusState;
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

const INITIAL_STATUS: SetupStatusItem[] = [
  { id: 'device', status: 'done' },
  { id: 'equipment', hasSublabel: true, status: 'active' },
  { id: 'mapping', status: 'pending' },
  { id: 'onboarding', status: 'pending' },
  { id: 'validation', status: 'pending' },
  { id: 'alerts', status: 'pending' },
  { id: 'access', status: 'pending' },
  { id: 'done', status: 'pending' },
];

const STATUS_BADGE_STYLES: Record<StatusState, string> = {
  done: 'text-emerald-600 dark:text-emerald-400',
  active: 'text-sky-600 dark:text-sky-400',
  pending: 'text-slate-400 dark:text-slate-500',
};

const STATUS_CARD_STYLES: Record<StatusState, string> = {
  done: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/50',
  active: 'bg-sky-50 dark:bg-sky-950/30 border-sky-300 dark:border-sky-800',
  pending: 'bg-slate-50 dark:bg-slate-800/40 border-slate-200 dark:border-slate-800',
};

export const AIOnboarding: React.FC<AIOnboardingProps> = ({ onSkipToManualSetup }) => {
  const { t } = useTranslation('onboarding');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const statusList = INITIAL_STATUS;
  const [draft, setDraft] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasStarted = messages.length > 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isThinking]);

  const sendMessage = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', text: trimmed }]);
    setDraft('');
    setIsThinking(true);

    setTimeout(() => {
      setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: 'assistant', text: t('chat.underDevelopment') }]);
      setIsThinking(false);
    }, 650);
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
                  <div className="max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl rounded-tl-md px-4 py-3 shadow-xs">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-sky-600 dark:text-sky-400 mb-1">
                      {t('chat.assistantName')}
                    </div>
                    <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed">
                      {msg.text}
                    </p>
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
              className="flex-1 bg-transparent border-none! shadow-none! outline-none!"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
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

      {/* Setup Status Panel */}
      <div className="w-96 shrink-0 hidden lg:block h-full overflow-y-auto">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-5">
          <div className="flex items-center justify-between pb-3 mb-1 border-b border-slate-100 dark:border-slate-800">
            <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">
              {t('chat.setupStatus')}
            </h3>
            <ListChecks className="w-4 h-4 text-slate-400" />
          </div>

          <div className="space-y-2.5 pt-2">
            {statusList.map((item) => (
              <div
                key={item.id}
                className={`rounded-lg border p-3 flex items-start justify-between gap-2 transition-colors ${STATUS_CARD_STYLES[item.status]}`}
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  {item.status === 'done' ? (
                    <div className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0 mt-0.5">
                      <Check className="w-3 h-3" />
                    </div>
                  ) : (
                    <div
                      className={`w-5 h-5 rounded-full border-2 shrink-0 mt-0.5 ${
                        item.status === 'active'
                          ? 'border-sky-500'
                          : 'border-slate-300 dark:border-slate-600'
                      }`}
                    />
                  )}
                  <div className="min-w-0">
                    <div className={`text-sm font-medium leading-snug ${item.status === 'pending' ? 'text-slate-500 dark:text-slate-400' : 'text-slate-800 dark:text-slate-100'}`}>
                      {t(`chat.step.${item.id}`)}
                    </div>
                    {item.hasSublabel && (
                      <div className="text-[11px] text-sky-600 dark:text-sky-400 truncate">
                        {t(`chat.step.${item.id}Sub`)}
                      </div>
                    )}
                  </div>
                </div>
                <span className={`text-[10px] font-bold uppercase tracking-wider shrink-0 mt-0.5 ${STATUS_BADGE_STYLES[item.status]}`}>
                  {t(`chat.state.${item.status}`)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

    </div>
  );
};
