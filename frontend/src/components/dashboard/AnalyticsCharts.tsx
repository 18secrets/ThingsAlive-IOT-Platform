import React, { useState } from 'react';

// Status colors are reserved for operational state and reused consistently
// across the app (emerald = healthy/online, amber = needs attention, slate =
// neutral/idle) — never repurposed as arbitrary series colors.
const STATUS_HEX = {
  good: '#10b981',
  warning: '#f59e0b',
  neutral: '#94a3b8',
};

interface ConnectivityGroup {
  label: string;
  online: number;
  offline: number;
}

interface DeviceConnectivityChartProps {
  title: string;
  subtitle?: string;
  groups: ConnectivityGroup[];
}

// Horizontal stacked bars: one row per group (client, or plant), split into
// an Online (emerald) and Offline (amber) segment, scaled to the busiest
// group so bar length stays comparable across rows.
export const DeviceConnectivityChart: React.FC<DeviceConnectivityChartProps> = ({ title, subtitle, groups }) => {
  const [hovered, setHovered] = useState<string | null>(null);
  const maxTotal = Math.max(1, ...groups.map((g) => g.online + g.offline));

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">{title}</h3>
          {subtitle && <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400 shrink-0">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: STATUS_HEX.good }} />
            Online
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: STATUS_HEX.warning }} />
            Offline
          </span>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="py-8 text-center text-slate-400 text-xs">No devices to chart yet.</div>
      ) : (
        <div className="space-y-3.5">
          {groups.map((g) => {
            const total = g.online + g.offline;
            const onlinePct = (g.online / maxTotal) * 100;
            const offlinePct = (g.offline / maxTotal) * 100;
            const dimmed = hovered !== null && hovered !== g.label;

            return (
              <div
                key={g.label}
                onMouseEnter={() => setHovered(g.label)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(g.label)}
                onBlur={() => setHovered(null)}
                tabIndex={0}
                role="img"
                aria-label={`${g.label}: ${g.online} online, ${g.offline} offline of ${total} devices`}
                className="focus:outline-none"
              >
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-medium text-slate-700 dark:text-slate-200 truncate">{g.label}</span>
                  <span className="text-slate-400 dark:text-slate-500 font-mono text-[11px] shrink-0">
                    {g.online}/{total} online
                  </span>
                </div>
                <div className="flex h-5 rounded-md overflow-hidden bg-slate-100 dark:bg-slate-800 transition-opacity duration-150" style={{ opacity: dimmed ? 0.45 : 1 }}>
                  {g.online > 0 && (
                    <div
                      className={`h-full flex items-center justify-end pr-1.5 ${g.offline > 0 ? 'mr-0.5' : ''} ${g.offline === 0 ? 'rounded-r-md' : ''}`}
                      style={{ width: `${onlinePct}%`, background: STATUS_HEX.good, minWidth: g.online > 0 ? '2px' : 0 }}
                    >
                      {onlinePct > 10 && <span className="text-[10px] font-semibold text-white leading-none">{g.online}</span>}
                    </div>
                  )}
                  {g.offline > 0 && (
                    <div
                      className="h-full flex items-center justify-end pr-1.5 rounded-r-md"
                      style={{ width: `${offlinePct}%`, background: STATUS_HEX.warning, minWidth: '2px' }}
                    >
                      {offlinePct > 10 && <span className="text-[10px] font-semibold text-white leading-none">{g.offline}</span>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

interface EquipmentStatusChartProps {
  title: string;
  subtitle?: string;
  active: number;
  underMaintenance: number;
  idle: number;
}

// A row of horizontal bars, one per equipment status, scaled to the largest
// count. Always direct-labeled (name + count) since these low-chroma status
// colors read at reduced contrast against the surface.
export const EquipmentStatusChart: React.FC<EquipmentStatusChartProps> = ({ title, subtitle, active, underMaintenance, idle }) => {
  const [hovered, setHovered] = useState<string | null>(null);
  const rows = [
    { key: 'Active', value: active, color: STATUS_HEX.good },
    { key: 'Under Maintenance', value: underMaintenance, color: STATUS_HEX.warning },
    { key: 'Idle', value: idle, color: STATUS_HEX.neutral },
  ];
  const maxValue = Math.max(1, ...rows.map((r) => r.value));
  const total = active + underMaintenance + idle;

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-5">
      <div className="mb-4">
        <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">{title}</h3>
        {subtitle && <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>}
      </div>

      {total === 0 ? (
        <div className="py-8 text-center text-slate-400 text-xs">No equipment to chart yet.</div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const pct = (r.value / maxValue) * 100;
            const dimmed = hovered !== null && hovered !== r.key;
            return (
              <div
                key={r.key}
                onMouseEnter={() => setHovered(r.key)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(r.key)}
                onBlur={() => setHovered(null)}
                tabIndex={0}
                role="img"
                aria-label={`${r.key}: ${r.value} of ${total} equipment`}
                className="flex items-center gap-3 focus:outline-none"
              >
                <span className="w-32 shrink-0 text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{r.key}</span>
                <div className="flex-1 h-4 rounded-md bg-slate-100 dark:bg-slate-800 transition-opacity duration-150" style={{ opacity: dimmed ? 0.45 : 1 }}>
                  {r.value > 0 && (
                    <div
                      className="h-full rounded-md flex items-center justify-end pr-2 transition-[width] duration-300"
                      style={{ width: `${Math.max(pct, 6)}%`, background: r.color }}
                    >
                      {pct > 18 && <span className="text-[10px] font-semibold text-white leading-none">{r.value}</span>}
                    </div>
                  )}
                </div>
                {pct <= 18 && <span className="w-6 text-right shrink-0 text-[11px] font-mono text-slate-500 dark:text-slate-400">{r.value}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
