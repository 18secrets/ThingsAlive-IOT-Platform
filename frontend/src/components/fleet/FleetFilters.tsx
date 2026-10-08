import React, { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, Search, X } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
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

export const FleetFilters: React.FC<{
  scope: FleetScope;
  onChange: (next: FleetScope) => void;
  /** Shows a second "Selected Thing" picker, always visible next to the
   *  Filters button — narrowing to one machine, matching client-ui-new's
   *  ThingFilters `onSelect` row. Omit on pages (like Scenarios) that don't
   *  narrow to a single Thing. */
  selectedId?: string;
  onSelectId?: (id: string) => void;
  things?: FleetThing[];
}> = ({ scope, onChange, selectedId, onSelectId, things }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(scope);
  const containerRef = useRef<HTMLDivElement>(null);

  // Re-seed the draft from whatever's actually applied every time the popover
  // opens — otherwise a cancelled-out-of edit from last time would still be
  // sitting in the fields the next time it's opened.
  useEffect(() => {
    if (open) setDraft(scope);
  }, [open, scope]);

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const isFiltered = scope.site !== 'all' || scope.type !== 'all' || scope.connection !== 'all' || !!scope.query;
  const visible = things ?? [];

  function applyDraft() {
    onChange(draft);
    setOpen(false);
  }

  function clearAll() {
    setDraft(DEFAULT_FLEET_SCOPE);
    onChange(DEFAULT_FLEET_SCOPE);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative flex items-center justify-between gap-3 flex-wrap">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors cursor-pointer"
      >
        <SlidersHorizontal className="w-4 h-4" />
        Filters
        {isFiltered && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
      </button>

      {onSelectId && (
        <div className="flex items-center gap-2 text-sm ml-auto">
          <span className="text-slate-500 dark:text-slate-400 font-medium shrink-0">Selected Thing</span>
          <SelectPicker
            data={[{ label: 'All matching Things', value: 'all' }, ...visible.map((t) => ({ label: `${t.id} · ${t.name}`, value: t.id }))]}
            value={selectedId && visible.some((t) => t.id === selectedId) ? selectedId : 'all'}
            onChange={(value) => onSelectId(value ?? 'all')}
            searchable={false}
            cleanable={false}
            className="min-w-[200px]"
          />
        </div>
      )}

      {open && (
        <div className="absolute top-full left-0 mt-2 w-[340px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden z-30">
          <div className="bg-sky-600 px-5 py-4 flex items-start justify-between text-white">
            <div>
              <h3 className="font-bold text-base">Filter Things</h3>
              <p className="text-xs text-sky-100 mt-0.5">Choose your scope, then apply.</p>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-white/15 transition-colors cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-5 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="block space-y-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Site / Plant</span>
                <SelectPicker
                  data={[{ label: 'All sites / plants', value: 'all' }, ...FLEET_LOCATIONS.map((l) => ({ label: l, value: l }))]}
                  value={draft.site}
                  onChange={(value) => setDraft({ ...draft, site: value ?? 'all' })}
                  searchable={false}
                  cleanable={false}
                  block
                />
              </div>
              <div className="block space-y-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Thing type</span>
                <SelectPicker
                  data={[{ label: 'All Thing types', value: 'all' }, ...FLEET_CATEGORIES.map((c) => ({ label: c, value: c }))]}
                  value={draft.type}
                  onChange={(value) => setDraft({ ...draft, type: value ?? 'all' })}
                  searchable={false}
                  cleanable={false}
                  block
                />
              </div>
              <div className="block space-y-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Connection status</span>
                <SelectPicker
                  data={[
                    { label: 'All connections', value: 'all' },
                    { label: 'Online', value: 'online' },
                    { label: 'Offline', value: 'offline' },
                  ]}
                  value={draft.connection}
                  onChange={(value) => setDraft({ ...draft, connection: (value ?? 'all') as FleetScope['connection'] })}
                  searchable={false}
                  cleanable={false}
                  block
                />
              </div>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Find a Thing</span>
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 z-10" />
                  <Input
                    value={draft.query}
                    onChange={(value) => setDraft({ ...draft, query: value })}
                    placeholder="Name or Thing ID"
                    className="pl-8!"
                  />
                </div>
              </label>
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800">
              <button onClick={clearAll} className="text-sm font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer">
                Clear selections
              </button>
              <button onClick={applyDraft} className="px-5 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold cursor-pointer">
                Apply filters
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
