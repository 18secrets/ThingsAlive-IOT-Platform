import React, { useEffect, useRef, useState } from 'react';
import { Bot, Sparkles, Send, X, HelpCircle, LayoutGrid, Wrench, Cpu, Maximize2, Minimize2 } from 'lucide-react';

interface AskAIWidgetProps {
  onOpenHelpModal?: () => void;
}

const QUICK_PROMPTS = [
  'Which devices are offline?',
  'Show Dust Collector status',
  'Volvo EC210 service status',
];

const HELP_TOPICS = [
  { icon: LayoutGrid, title: 'Admin Console & Sub-tabs', body: 'Manage Industry Types, telemetry Sensors, communication Protocols, Equipment Categories, Plants, and Tool Mappings.' },
  { icon: Wrench, title: 'Equipment & Categorization', body: 'Configure industrial excavators, mobile cranes, and conveyors with engine specifications, maintenance intervals, and fuel capacities.' },
  { icon: Cpu, title: 'Device Onboarding & Tool Mapping', body: 'Register hardware modems by IMEI and auto-bind sensor parameter channels via preconfigured Tool Profiles.' },
];

export const AskAIWidget: React.FC<AskAIWidgetProps> = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [inputQuery, setInputQuery] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string; time: string }>>([
    {
      role: 'assistant',
      text: 'Hello! I am your ThingsAlive Telematics AI Assistant. You can ask me about sensor telemetry thresholds, equipment health, CAN-bus mapping, or device onboarding status.',
      time: 'Just now',
    },
  ]);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isTyping]);

  const handleSend = (e?: React.FormEvent, prompt?: string) => {
    if (e) e.preventDefault();
    const userText = (prompt ?? inputQuery).trim();
    if (!userText) return;

    setMessages((prev) => [...prev, { role: 'user', text: userText, time: 'Just now' }]);
    setInputQuery('');
    setIsTyping(true);

    setTimeout(() => {
      let reply = "I've analyzed the fleet telemetry data across all active plants.";
      const queryLower = userText.toLowerCase();

      if (queryLower.includes('offline') || queryLower.includes('device') || queryLower.includes('131')) {
        reply = 'Device #131 (PowerCommand Cloud) on Generator Unit is currently OFFLINE. Last ping was 4 hours ago via Eicher Motors gateway. Diagnostic code: CAN-BUS TIMEOUT (Error 0x4B).';
      } else if (queryLower.includes('dust') || queryLower.includes('sensor') || queryLower.includes('cement')) {
        reply = 'Dust_Collector_Monitoring (SN-CBM-001) is active on the Kiln Drive Monitoring Kit. Current differential pressure is nominal at 1.4 kPa with opacity index at 3.2%.';
      } else if (queryLower.includes('excavator') || queryLower.includes('equipment') || queryLower.includes('volvo')) {
        reply = 'Volvo EC210 Crawler Excavator (ID #14, License UP32CE9136) at Lucknow Infrastructure Plant is active. Next scheduled hydraulic service is in 38 operational hours.';
      } else if (queryLower.includes('fuel') || queryLower.includes('capacity')) {
        reply = 'Category CAT-HEE-001 has normalized fuel capacity set to 400 Liters with automated telemetry percentage bounds enabled.';
      } else {
        reply = `Telemetry summary for "${userText}": 18 equipment items logged, 20 telematics units provisioned (9 online, 1 offline, 10 pending data cycle). All MODBUS and J1939 protocols are operating within expected latencies.`;
      }

      setIsTyping(false);
      setMessages((prev) => [...prev, { role: 'assistant', text: reply, time: 'Just now' }]);
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
          title="ThingsAlive Documentation & Help"
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
          <span>Ask AI</span>
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
                <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">ThingsAlive IoT OS Guide</h3>
              </div>
              <button
                onClick={() => setShowHelp(false)}
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
                      <div className="font-semibold text-sm text-slate-800 dark:text-slate-100">{topic.title}</div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">{topic.body}</p>
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
                Got it
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
                <h4 className="font-semibold text-sm leading-tight truncate">ThingsAlive Assistant</h4>
                <p className="text-[11px] text-sky-100/90 truncate">Fleet &amp; telemetry intelligence</p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setIsExpanded((prev) => !prev)}
                className="p-1.5 rounded-lg hover:bg-white/15 transition-colors text-white cursor-pointer"
                title={isExpanded ? 'Collapse' : 'Expand'}
              >
                {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>
              <button
                onClick={() => setIsOpen(false)}
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
                key={prompt}
                onClick={() => handleSend(undefined, prompt)}
                className="shrink-0 px-3 py-1.5 rounded-full bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 text-sky-700 dark:text-sky-300 text-[11px] font-medium hover:bg-sky-100 dark:hover:bg-sky-900/50 transition-colors cursor-pointer whitespace-nowrap"
              >
                {prompt}
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
                    {m.text}
                  </div>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 mt-1 px-1">{m.time}</span>
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
            <input
              type="text"
              value={inputQuery}
              onChange={(e) => setInputQuery(e.target.value)}
              placeholder="Ask about telematics, sensors, errors..."
              className="flex-1 px-4 py-2.5 text-xs bg-slate-100 dark:bg-slate-800 border border-transparent text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 rounded-full focus:outline-none focus:bg-white dark:focus:bg-slate-900 focus:border-sky-400 focus:ring-2 focus:ring-sky-500/20 transition-colors"
            />
            <button
              type="submit"
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
