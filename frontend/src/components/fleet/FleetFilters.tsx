import React from 'react';
import { Search, X } from 'lucide-react';
import { FLEET_CATEGORIES, FLEET_LOCATIONS, FleetThing } from '../../data/fleetMockData';

export interface FleetScope {
  site: string;
  type: string;
  connection: 'all' | 'online' | 'offline';
  query: string;
}

export const DEFAULT_FLEET_SCOPE: FleetScope = { site: 'all', type: 'all', connection: 'all', query: '' };

export function matchingFleet(things: FleetThing[], scope: FleetScope): FleetThing[] {
  return things.filter((t) =>
    (scope.site === 'all' || t.location === scope.site) &&
    (scope.type === 'all' || t.category === scope.type) &&
    (scope.connection === 'all' || (scope.connection === 'offline' ? t.offline : !t.offline)) &&
    `${t.name} ${t.id} ${t.category} ${t.location}`.toLowerCase().includes(scope.query.trim().toLowerCase())
  );
}

const selectClass = 'w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-700 dark:text-slate-200';

export const FleetFilters: React.FC<{
  scope: FleetScope;
  onChange: (next: FleetScope) => void;
  /** Shows a second "Selected Thing" row narrowing to one machine, matching
   *  client-ui-new's ThingFilters `onSelect` row. Omit on pages (like
   *  Scenarios) that don't narrow to a single Thing. */
  selectedId?: string;
  onSelectId?: (id: string) => void;
  things?: FleetThing[];
}> = ({ scope, onChange, selectedId, onSelectId, things }) => {
  const filtered = scope.site !== 'all' || scope.type !== 'all' || scope.connection !== 'all' || !!scope.query;
  const visible = things ?? [];

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Find a Thing</span>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={scope.query}
              onChange={(e) => onChange({ ...scope, query: e.target.value })}
              placeholder="Name or Thing ID"
              className={`${selectClass} pl-8`}
            />
          </div>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Site / Plant</span>
          <select className={selectClass} value={scope.site} onChange={(e) => onChange({ ...scope, site: e.target.value })}>
            <option value="all">All sites / plants</option>
            {FLEET_LOCATIONS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Thing type</span>
          <select className={selectClass} value={scope.type} onChange={(e) => onChange({ ...scope, type: e.target.value })}>
            <option value="all">All Thing types</option>
            {FLEET_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Connection status</span>
          <select className={selectClass} value={scope.connection} onChange={(e) => onChange({ ...scope, connection: e.target.value as FleetScope['connection'] })}>
            <option value="all">All connections</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
          </select>
        </label>
      </div>
      {filtered && (
        <button
          onClick={() => onChange(DEFAULT_FLEET_SCOPE)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
        >
          <X className="w-3.5 h-3.5" /> Clear filters
        </button>
      )}
      {onSelectId && (
        <label className="block space-y-1 max-w-sm">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Selected Thing</span>
          <select className={selectClass} value={selectedId && visible.some((t) => t.id === selectedId) ? selectedId : 'all'} onChange={(e) => onSelectId(e.target.value)}>
            <option value="all">All matching Things</option>
            {visible.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}
          </select>
        </label>
      )}
    </div>
  );
};
