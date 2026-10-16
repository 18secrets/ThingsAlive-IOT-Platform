import React, { useEffect, useRef, useState } from 'react';
import { Bot, Sparkles, Send, X, HelpCircle, LayoutGrid, Wrench, Cpu, Maximize2, Minimize2 } from 'lucide-react';
import { Input } from 'rsuite';
import { useTranslation } from 'react-i18next';

interface AskAIWidgetProps {
  onOpenHelpModal?: () => void;
}

// The canned replies below match on the English wording, so a chip carries its
// English text as `match` and shows the translation.
const QUICK_PROMPTS = [
  { key: 'offline', match: 'Which devices are offline?' },
  { key: 'dust', match: 'Show Dust Collector status' },
  { key: 'volvo', match: 'Volvo EC210 service status' },
];

const HELP_TOPICS = [
  { icon: LayoutGrid, key: 'admin' },
  { icon: Wrench, key: 'equipment' },
  { icon: Cpu, key: 'devices' },
];

// A message is stored as a key (plus values) so it re-renders in the new language.
type ChatMessage = { role: 'user' | 'assistant'; text: string; key?: string; values?: Record<string, string> };

export const AskAIWidget: React.FC<AskAIWidgetProps> = () => {
  const { t } = useTranslation('shared');
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [inputQuery, setInputQuery] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', text: '', key: 'askAI.welcome' },
  ]);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isTyping]);

  const handleSend = (e?: React.FormEvent, prompt?: string, match?: string) => {
    if (e) e.preventDefault();
    const userText = (prompt ?? inputQuery).trim();
    if (!userText) return;

    setMessages((prev) => [...prev, { role: 'user', text: userText }]);
    setInputQuery('');
    setIsTyping(true);

    setTimeout(() => {
      let reply: Pick<ChatMessage, 'key' | 'values'>;
      const queryLower = (match ?? userText).toLowerCase();

      if (queryLower.includes('offline') || queryLower.includes('device') || queryLower.includes('131')) {
        reply = { key: 'askAI.reply.offline' };
      } else if (queryLower.includes('dust') || queryLower.includes('sensor') || queryLower.includes('cement')) {
        reply = { key: 'askAI.reply.dust' };
      } else if (queryLower.includes('excavator') || queryLower.includes('equipment') || queryLower.includes('volvo')) {
        reply = { key: 'askAI.reply.volvo' };
      } else if (queryLower.includes('fuel') || queryLower.includes('capacity')) {
        reply = { key: 'askAI.reply.fuel' };
      } else {
        reply = { key: 'askAI.reply.summary', values: { query: userText } };
      }

      setIsTyping(false);
      setMessages((prev) => [...prev, { role: 'assistant', text: '', ...reply }]);
    }, 900);
  };

  return (
    <>
      {/* Floating Buttons */}
      <div
        id="floating-ask-ai"
        className="fixed bottom-5 right-6 z-40 flex items-center gap-3"
        data-purpose="floating-ask-ai"
      >
        <button
          id="help-circle-btn"
          onClick={() => setShowHelp(true)}
          className="w-11 h-11 rounded-full bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 flex items-center justify-center shadow-lg shadow-slate-900/5 hover:border-sky-300 hover:text-sky-600 dark:hover:border-sky-700 dark:hover:text-sky-400 hover:-translate-y-0.5 transition-all cursor-pointer"
          title={t('askAI.helpTitle')}
        >
          <HelpCircle className="w-5 h-5" />
        </button>

        <button
          id="ask-ai-pill-btn"
          onClick={() => setIsOpen(!isOpen)}
          className="relative flex items-center gap-2 bg-gradient-to-br from-sky-500 to-sky-700 hover:from-sky-400 hover:to-sky-600 text-white text-sm font-semibold pl-3.5 pr-5 py-3 rounded-full shadow-lg shadow-sky-600/30 hover:shadow-xl hover:shadow-sky-600/40 hover:-translate-y-0.5 transition-all cursor-pointer"
        >
          <span className="relative flex items-center justify-center w-5 h-5">
            <Bot className="w-5 h-5" />
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-sky-600" />
          </span>
          <span>{t('askAI.button')}</span>
        </button>
      </div>

      {/* Help Modal */}
      {showHelp && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-150">
            <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
                  <HelpCircle className="w-4 h-4" />
                </div>
                <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">{t('askAI.guideTitle')}</h3>
              </div>
              <button
                onClick={() => setShowHelp(false)}
                aria-label={t('close')}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-3">
              {HELP_TOPICS.map((topic, i) => {
                const Icon = topic.icon;
                return (
                  <div key={i} className="flex items-start gap-3 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30">
                    <div className="w-8 h-8 rounded-lg bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
                      <Icon className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="font-semibold text-sm text-slate-800 dark:text-slate-100">{t(`askAI.topics.${topic.key}.title`)}</div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">{t(`askAI.topics.${topic.key}.body`)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-6 pb-6 flex justify-end">
              <button
                onClick={() => setShowHelp(false)}
                className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-semibold shadow-xs transition-colors cursor-pointer"
              >
                {t('askAI.gotIt')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat Drawer */}
      {isOpen && (
        <div
          className={`fixed bottom-24 right-6 bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col z-50 overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-200 transition-[width,height] ease-out ${
            isExpanded
              ? 'w-[640px] max-w-[calc(100vw-3rem)] h-[calc(100vh-8rem)] max-h-[800px]'
              : 'w-96 max-w-[calc(100vw-3rem)] h-[520px]'
          }`}
        >
          {/* Header */}
          <div className="px-4 py-3.5 bg-gradient-to-r from-sky-600 to-sky-700 text-white flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="relative w-9 h-9 rounded-full bg-white/15 flex items-center justify-center shrink-0">
                <Sparkles className="w-4.5 h-4.5" />
                <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-sky-700" />
              </div>
              <div className="min-w-0">
                <h4 className="font-semibold text-sm leading-tight truncate">{t('askAI.assistantName')}</h4>
                <p className="text-[11px] text-sky-100/90 truncate">{t('askAI.assistantTagline')}</p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setIsExpanded((prev) => !prev)}
                className="p-1.5 rounded-lg hover:bg-white/15 transition-colors text-white cursor-pointer"
                title={isExpanded ? t('askAI.collapse') : t('askAI.expand')}
              >
                {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>
              <button
                onClick={() => setIsOpen(false)}
                aria-label={t('close')}
                className="p-1.5 rounded-lg hover:bg-white/15 transition-colors text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Quick prompt chips */}
          <div className="px-3 py-2.5 border-b border-slate-100 dark:border-slate-800 flex gap-1.5 overflow-x-auto">
            {QUICK_PROMPTS.map((prompt) => (
              <button
                key={prompt.key}
                onClick={() => handleSend(undefined, t(`askAI.prompts.${prompt.key}`), prompt.match)}
                className="shrink-0 px-3 py-1.5 rounded-full bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 text-sky-700 dark:text-sky-300 text-[11px] font-medium hover:bg-sky-100 dark:hover:bg-sky-900/50 transition-colors cursor-pointer whitespace-nowrap"
              >
                {t(`askAI.prompts.${prompt.key}`)}
              </button>
            ))}
          </div>

          {/* Messages Feed */}
          <div ref={feedRef} className="flex-1 p-4 overflow-y-auto space-y-4 bg-slate-50/50 dark:bg-slate-950/30">
            {messages.map((m, idx) => (
              <div key={idx} className={`flex items-end gap-2 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                {m.role === 'assistant' && (
                  <div className="w-6 h-6 rounded-full bg-sky-600 text-white flex items-center justify-center shrink-0 mb-0.5">
                    <Bot className="w-3.5 h-3.5" />
                  </div>
                )}
                <div className={`max-w-[78%] flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                  <div
                    className={`px-3.5 py-2.5 text-xs leading-relaxed shadow-xs ${
                      m.role === 'user'
                        ? 'bg-sky-600 text-white rounded-2xl rounded-br-md'
                        : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-2xl rounded-bl-md'
                    }`}
                  >
                    {m.key ? t(m.key, m.values) : m.text}
                  </div>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 mt-1 px-1">{t('askAI.justNow')}</span>
                </div>
              </div>
            ))}

            {isTyping && (
              <div className="flex items-end gap-2">
                <div className="w-6 h-6 rounded-full bg-sky-600 text-white flex items-center justify-center shrink-0 mb-0.5">
                  <Bot className="w-3.5 h-3.5" />
                </div>
                <div className="px-4 py-3 rounded-2xl rounded-bl-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500 animate-bounce [animation-delay:-0.3s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500 animate-bounce [animation-delay:-0.15s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500 animate-bounce" />
                </div>
              </div>
            )}
          </div>

          {/* Input Footer */}
          <form
            onSubmit={handleSend}
            className="p-3 bg-white dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2 shrink-0"
          >
            <Input
              value={inputQuery}
              onChange={(value) => setInputQuery(value)}
              placeholder={t('askAI.placeholder')}
              size="sm"
              className="flex-1"
            />
            <button
              type="submit"
              aria-label={t('askAI.send')}
              className="w-9 h-9 shrink-0 flex items-center justify-center rounded-full bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-40 disabled:hover:bg-sky-600 transition-colors cursor-pointer"
              disabled={!inputQuery.trim()}
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      )}
    </>
  );
};
