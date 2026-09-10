import React, { useState } from 'react';
import { Bot, Sparkles, Send, X, HelpCircle, Activity, Radio, Cpu, Wrench } from 'lucide-react';

interface AskAIWidgetProps {
  onOpenHelpModal?: () => void;
}

export const AskAIWidget: React.FC<AskAIWidgetProps> = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [inputQuery, setInputQuery] = useState('');
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string; time: string }>>([
    {
      role: 'assistant',
      text: 'Hello! I am your ThingsAlive Telematics AI Assistant. You can ask me about sensor telemetry thresholds, equipment health, CAN-bus mapping, or device onboarding status.',
      time: 'Just now'
    }
  ]);

  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputQuery.trim()) return;

    const userText = inputQuery.trim();
    const newMessages = [
      ...messages,
      { role: 'user' as const, text: userText, time: 'Just now' }
    ];
    setMessages(newMessages);
    setInputQuery('');

    // Generate smart response based on keywords
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

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: reply, time: 'Just now' }
      ]);
    }, 600);
  };

  return (
    <>
      {/* Floating Buttons in Bottom Right */}
      <div 
        id="floating-ask-ai"
        className="fixed bottom-5 right-6 z-40 flex items-center gap-2.5"
        data-purpose="floating-ask-ai"
      >
        {/* Help / Question Mark Circle */}
        <button 
          id="help-circle-btn"
          onClick={() => setShowHelp(true)}
          className="w-10 h-10 bg-[#FFFFFF] dark:bg-[#1A1918] text-[#121212] dark:text-[#FDFCF5] border border-[#121212]/20 dark:border-white/20 flex items-center justify-center shadow-md hover:border-[#FF4D00] hover:text-[#FF4D00] transition-colors focus:outline-none cursor-pointer"
          title="ThingsAlive Documentation & Help"
        >
          <span className="font-serif font-bold text-sm">?</span>
        </button>

        {/* Ask AI Pill Button */}
        <button 
          id="ask-ai-pill-btn"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 bg-[#121212] hover:bg-[#FF4D00] text-white dark:bg-[#FDFCF5] dark:text-[#121212] dark:hover:bg-[#FF4D00] dark:hover:text-white border border-[#121212] dark:border-white text-xs font-sans uppercase tracking-[0.14em] font-bold px-4 py-2.5 shadow-md transition-colors focus:outline-none cursor-pointer"
        >
          <Bot className="w-4 h-4" />
          <span>Ask AI</span>
        </button>
      </div>

      {/* Help Modal */}
      {showHelp && (
        <div className="fixed inset-0 bg-[#121212]/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-[#FFFFFF] dark:bg-[#1A1918] shadow-2xl border border-[#121212]/20 dark:border-white/20 w-full max-w-lg overflow-hidden p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[#121212]/10 dark:border-white/10 pb-3">
              <div className="flex items-center gap-2 text-[#121212] dark:text-[#FDFCF5]">
                <HelpCircle className="w-5 h-5 text-[#FF4D00]" />
                <h3 className="font-serif font-bold text-lg">ThingsAlive IoT OS Guide</h3>
              </div>
              <button 
                onClick={() => setShowHelp(false)}
                className="text-[#121212]/50 hover:text-[#FF4D00] dark:text-[#FDFCF5]/50 dark:hover:text-[#FF4D00] p-1 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3 text-xs text-[#121212]/70 dark:text-[#FDFCF5]/70 leading-relaxed font-sans">
              <div className="p-3 bg-[#FAF9F2] dark:bg-[#151514] border border-[#121212]/15 dark:border-white/15">
                <div className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] text-sm mb-0.5">1. Admin Console & Sub-tabs</div>
                Manage Industry Types, telemetry Sensors, communication Protocols, Equipment Categories, Plants, and Tool Mappings.
              </div>
              <div className="p-3 bg-[#FAF9F2] dark:bg-[#151514] border border-[#121212]/15 dark:border-white/15">
                <div className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] text-sm mb-0.5">2. Equipment & Categorization</div>
                Configure industrial excavators, mobile cranes, and conveyors with engine specifications, maintenance intervals, and fuel capacities.
              </div>
              <div className="p-3 bg-[#FAF9F2] dark:bg-[#151514] border border-[#121212]/15 dark:border-white/15">
                <div className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] text-sm mb-0.5">3. Device Onboarding & Tool Mapping</div>
                Register hardware modems by IMEI and auto-bind sensor parameter channels via preconfigured Tool Profiles.
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <button 
                onClick={() => setShowHelp(false)}
                className="px-5 py-2 bg-[#121212] text-[#FDFCF5] hover:bg-[#FF4D00] hover:text-white dark:bg-[#FDFCF5] dark:text-[#121212] dark:hover:bg-[#FF4D00] dark:hover:text-white border border-[#121212] dark:border-white text-xs font-sans uppercase tracking-[0.14em] font-bold transition-colors cursor-pointer"
              >
                Got It
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Interactive AI Drawer */}
      {isOpen && (
        <div className="fixed bottom-20 right-6 w-96 max-w-[calc(100vw-3rem)] h-[480px] bg-[#FFFFFF] dark:bg-[#1A1918] shadow-2xl border border-[#121212]/20 dark:border-white/20 flex flex-col z-50 overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-200">
          {/* Header */}
          <div className="px-4 py-3 bg-[#121212] dark:bg-[#151514] text-[#FDFCF5] border-b border-white/15 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-1 border border-white/20 bg-white/10">
                <Sparkles className="w-4 h-4 text-[#FF4D00]" />
              </div>
              <div>
                <h4 className="font-serif font-bold text-xs">ThingsAlive Telematics AI</h4>
                <p className="text-[10px] text-[#FDFCF5]/60 font-mono">Live fleet & telemetry intelligence</p>
              </div>
            </div>
            <button 
              onClick={() => setIsOpen(false)}
              className="p-1 hover:text-[#FF4D00] transition-colors text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Quick prompt chips */}
          <div className="px-3 py-2 bg-[#FAF9F2] dark:bg-[#151514] border-b border-[#121212]/10 dark:border-white/10 flex gap-1.5 overflow-x-auto text-[11px] whitespace-nowrap">
            <button 
              onClick={() => setInputQuery("Which devices are offline?")}
              className="px-2 py-1 bg-[#FFFFFF] dark:bg-[#1A1918] border border-[#121212]/15 dark:border-white/15 text-[#121212] dark:text-[#FDFCF5] hover:border-[#FF4D00] hover:text-[#FF4D00] transition-colors cursor-pointer font-mono text-[10px]"
            >
              Offline devices
            </button>
            <button 
              onClick={() => setInputQuery("Show Dust Collector status")}
              className="px-2 py-1 bg-[#FFFFFF] dark:bg-[#1A1918] border border-[#121212]/15 dark:border-white/15 text-[#121212] dark:text-[#FDFCF5] hover:border-[#FF4D00] hover:text-[#FF4D00] transition-colors cursor-pointer font-mono text-[10px]"
            >
              Dust collector
            </button>
            <button 
              onClick={() => setInputQuery("Volvo EC210 service status")}
              className="px-2 py-1 bg-[#FFFFFF] dark:bg-[#1A1918] border border-[#121212]/15 dark:border-white/15 text-[#121212] dark:text-[#FDFCF5] hover:border-[#FF4D00] hover:text-[#FF4D00] transition-colors cursor-pointer font-mono text-[10px]"
            >
              Volvo EC210
            </button>
          </div>

          {/* Messages Feed */}
          <div className="flex-1 p-4 overflow-y-auto space-y-3 text-xs font-sans">
            {messages.map((m, idx) => (
              <div 
                key={idx} 
                className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div 
                  className={`max-w-[85%] px-3.5 py-2.5 leading-relaxed border ${
                    m.role === 'user' 
                      ? 'bg-[#121212] text-white dark:bg-[#FDFCF5] dark:text-[#121212] border-[#121212] dark:border-white' 
                      : 'bg-[#FAF9F2] dark:bg-[#151514] text-[#121212] dark:text-[#FDFCF5] border-[#121212]/15 dark:border-white/15'
                  }`}
                >
                  {m.text}
                </div>
                <span className="text-[9px] font-mono text-[#121212]/40 dark:text-[#FDFCF5]/40 mt-1 px-1">{m.time}</span>
              </div>
            ))}
          </div>

          {/* Input Footer */}
          <form 
            onSubmit={handleSend}
            className="p-3 bg-[#FFFFFF] dark:bg-[#1A1918] border-t border-[#121212]/15 dark:border-white/15 flex items-center gap-2"
          >
            <input 
              type="text" 
              value={inputQuery}
              onChange={(e) => setInputQuery(e.target.value)}
              placeholder="Ask about telematics, sensors, errors..."
              className="flex-1 px-3 py-2 text-xs bg-[#FDFCF5] dark:bg-[#121212] border border-[#121212]/20 dark:border-white/20 text-[#121212] dark:text-[#FDFCF5] placeholder-[#121212]/40 dark:placeholder-[#FDFCF5]/40 focus:outline-none focus:border-[#FF4D00]"
            />
            <button 
              type="submit"
              className="p-2 bg-[#121212] text-white hover:bg-[#FF4D00] dark:bg-[#FDFCF5] dark:text-[#121212] dark:hover:bg-[#FF4D00] dark:hover:text-white border border-[#121212] dark:border-white transition-colors disabled:opacity-40 cursor-pointer"
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
