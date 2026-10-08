import React from 'react';
import { Box, MapPin, ChevronRight } from 'lucide-react';
import { FleetThing } from '../../data/fleetMockData';

// Illustrative construction-site scene, ported from the client-ui-new demo's
// site-overview.tsx. Decorative only — not an actual site map or GPS layout.
export const SiteScene: React.FC<{ things: FleetThing[]; onOpen: (id: string) => void }> = ({ things, onOpen }) => {
  const crane = things.find((t) => /crane/i.test(t.category));
  const excavator = things.find((t) => /excavator/i.test(t.category));
  const tipper = things.find((t) => /tipper|dumper/i.test(t.category));

  function machineTarget(t: FleetThing | undefined) {
    if (!t) return {};
    return {
      role: 'button' as const, tabIndex: 0, 'aria-label': `Open ${t.name} (${t.id}) details`,
      className: 'cursor-pointer', onClick: () => onOpen(t.id),
      onKeyDown: (e: React.KeyboardEvent<SVGGElement>) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t.id); } },
    };
  }

  return (
    <div className="relative h-[360px] rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-[#8aa48d]">
      <svg viewBox="0 0 1000 520" preserveAspectRatio="xMidYMid slice" className="w-full h-full block" aria-label="Illustrative construction site, not an actual site map" role="group">
        <defs>
          <linearGradient id="ccGround" x2="0" y2="1"><stop stopColor="#bac8b5" /><stop offset="1" stopColor="#79937d" /></linearGradient>
          <pattern id="ccGrid" width="42" height="42" patternUnits="userSpaceOnUse"><path d="M42 0H0V42" fill="none" stroke="#ffffff18" /></pattern>
        </defs>
        <rect width="1000" height="520" fill="url(#ccGround)" /><rect width="1000" height="520" fill="url(#ccGrid)" />
        <path d="M-20 370L600 0H710L70 430ZM140 520L990 45L1060 100L250 550" fill="#788486" />
        <path d="M-10 405L655 15M205 515L1000 76" stroke="#e4dec1" strokeWidth="3" strokeDasharray="18 14" />
        <path d="M320 350L630 170L875 310L559 491Z" fill="#c5b99a" stroke="#ece3c7" strokeWidth="5" />
        <path d="M402 288L604 172L775 267L572 387Z" fill="#9c9d92" />
        <path d="M402 288V211L604 95V172M604 95L775 190V267M402 211L572 308L775 190M572 308V387" fill="#cbd0c6" stroke="#eef0e7" strokeWidth="7" />
        {[0, 1, 2, 3].map((i) => <g key={i} stroke="#e9ece3" strokeWidth="7"><path d={`M${430 + i * 44} ${227 + i * 25}v76M${606 + i * 44} ${288 - i * 26}v78`} /></g>)}
        <g {...machineTarget(crane)}><title>{crane ? `${crane.name} · ${crane.id} · Open details` : 'No crane in this selection'}</title><rect x="430" y="35" width="465" height="265" fill="transparent" /><g stroke="#e9ab25" strokeWidth="8" fill="none"><path d="M665 295V45L440 170M665 45L885 120M645 292L665 245L645 210L665 172L645 132L665 95M645 295V58" /><path d="M665 45L440 145V170L665 70L885 120V98Z" strokeWidth="4" /></g><path d="M467 160V255" stroke="#384750" strokeWidth="2" /></g>
        <g transform="translate(325 353)" {...machineTarget(excavator)}><title>{excavator ? `${excavator.name} · ${excavator.id} · Open details` : 'No excavator in this selection'}</title><rect x="-60" y="-115" width="195" height="145" fill="transparent" /><ellipse rx="53" ry="17" fill="#47514c" /><path d="M-43-9h67v-31h-52Z" fill="#eab230" /><path d="M-15-42h32v-32H-8Z" fill="#344c57" stroke="#f3c440" strokeWidth="5" /><path d="M20-35L62-98L101-76L109-29" fill="none" stroke="#efb82d" strokeWidth="13" /><path d="M94-36h30l-4 21H98Z" fill="#665b42" /></g>
        <g transform="translate(784 370)" {...machineTarget(tipper)}><title>{tipper ? `${tipper.name} · ${tipper.id} · Open details` : 'No tipper in this selection'}</title><rect x="-65" y="-80" width="145" height="120" fill="transparent" /><path d="M-48 0l65-36 43 23L-5 24Z" fill="#d58f2c" /><path d="M-48 0v-27l65-36v27M17-63l43 23v27" fill="#e6b44e" /><path d="M-48-27L17-63L60-40L-5-3Z" fill="#b2874f" /><circle cx="-27" cy="16" r="12" fill="#34434a" /><circle cx="32" cy="-17" r="12" fill="#34434a" /></g>
        <g fill="#e1e7e2" stroke="#6d8290" strokeWidth="2"><path d="M83 203l115-65 68 38-115 66Z" /><path d="M83 203v38l68 39v-38M151 280l115-66v-38" /><path d="M741 65l108-59 68 38-108 60Z" /><path d="M741 65v35l68 39v-35M809 139l108-61V44" /></g>
        <g fill="#47725a">{[30, 100, 180, 850, 930, 980].map((x, i) => <circle key={x} cx={x} cy={i < 3 ? 90 : 470} r="27" />)}</g>
      </svg>
      <div className="absolute top-2.5 left-2.5 right-2.5 flex justify-between gap-2">
        <span className="bg-white text-sky-700 px-2.5 py-1.5 text-[11px] font-medium rounded">Construction site</span>
        <span className="bg-[#142638e8] text-white px-2.5 py-1.5 text-[11px] rounded">Concept view · sample locations</span>
      </div>
      <div className="absolute top-[53px] left-2.5 w-[185px] max-h-[260px] overflow-auto p-3 bg-[#112033e8] text-[#e4edf6] border border-[#5c6a78] rounded-md space-y-2">
        <b className="text-[12px] flex items-center gap-1.5"><MapPin className="w-3 h-3" /> Site hierarchy</b>
        {things.slice(0, 8).map((t) => (
          <button key={t.id} onClick={() => onOpen(t.id)} className="flex items-center gap-1.5 text-[11px] text-left w-full hover:bg-[#365878] rounded p-1">
            <Box className="w-3 h-3 shrink-0" />{t.id} · {t.name}<ChevronRight className="w-3 h-3 ml-auto shrink-0" />
          </button>
        ))}
      </div>
      <div className="absolute bottom-2 left-2.5 bg-[#162a3be8] text-[#dce7ed] text-[9px] px-1.5 py-1 rounded">
        Click a machine or site-hierarchy label to open Thing details · illustrative layout
      </div>
    </div>
  );
};
