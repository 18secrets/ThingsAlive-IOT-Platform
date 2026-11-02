import React, { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, Search, X } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { Plant } from '../../lib/api';

export type EquipmentConnection = 'all' | 'online' | 'offline';

export interface EquipmentFilterScope {
  plantId: string;
  classSlug: string;
  connection: EquipmentConnection;
  query: string;
}

export const DEFAULT_EQUIPMENT_FILTER_SCOPE: EquipmentFilterScope = {
  plantId: 'all', classSlug: 'all', connection: 'all', query: '',
};

export interface SelectableEquipment {
  sourceSystem: string;
  externalId: string;
  label: string;
}

/** The "Filters" pill + popover design the classic mock dashboard used (search, site,
 *  equipment class, connection status on the left; a single-equipment picker on
 *  the right) over real fields: plant/equipment-class from EquipmentProfile,
 *  connection from the device-health module's link state (dark = offline,
 *  everything else observed = online). */
export const EquipmentFilters: React.FC<{
  scope: EquipmentFilterScope;
  onChange: (next: EquipmentFilterScope) => void;
  plants: Plant[];
  classes: string[];
  /** Omit to hide the right-side "Selected equipment" picker. */
  equipmentOptions?: SelectableEquipment[];
  selectedKey?: string;
  onSelect?: (key: string) => void;
  /** Off where the cards carry no connection status and the page never applies the
   *  choice (TC_124): a filter that changes nothing reads as broken. */
  showConnection?: boolean;
}> = ({ scope, onChange, plants, classes, equipmentOptions, selectedKey, onSelect, showConnection = true }) => {
  const { t } = useTranslation('shared');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(scope);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const isFiltered = scope.plantId !== 'all' || scope.classSlug !== 'all' || scope.connection !== 'all' || !!scope.query;

  function applyDraft() {
    onChange(draft);
    setOpen(false);
  }

  function clearAll() {
    setDraft(DEFAULT_EQUIPMENT_FILTER_SCOPE);
    onChange(DEFAULT_EQUIPMENT_FILTER_SCOPE);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative flex items-center justify-between gap-3 flex-wrap">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors cursor-pointer"
      >
        <SlidersHorizontal className="w-4 h-4" />
        {t('filters.button')}
        {isFiltered && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
      </button>

      {equipmentOptions && onSelect && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2 text-sm w-full sm:w-auto sm:ml-auto min-w-0">
          <span className="text-slate-500 dark:text-slate-400 font-medium shrink-0">{t('filters.selectedEquipment')}</span>
          <SelectPicker
            data={[{ label: t('filters.allMatchingEquipment'), value: 'all' }, ...equipmentOptions.map((e) => ({ label: e.label, value: `${e.sourceSystem}|${e.externalId}` }))]}
            value={selectedKey && equipmentOptions.some((e) => `${e.sourceSystem}|${e.externalId}` === selectedKey) ? selectedKey : 'all'}
            onChange={(value) => onSelect(value ?? 'all')}
            searchable
            cleanable={false}
            block
            className="sm:w-auto! sm:min-w-[220px]"
          />
        </div>
      )}

      {open && (
        <div className="absolute top-full left-0 mt-2 w-[340px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden z-30">
          <div className="bg-sky-600 px-5 py-4 flex items-start justify-between text-white">
            <div>
              <h3 className="font-bold text-base">{t('filters.title')}</h3>
              <p className="text-xs text-sky-100 mt-0.5">{t('filters.intro')}</p>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label={t('close')}
              className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-white/15 transition-colors cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-5 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="block space-y-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('filters.sitePlant')}</span>
                <SelectPicker
                  data={[{ label: t('filters.allSitesPlants'), value: 'all' }, ...plants.map((p) => ({ label: p.name, value: p.id }))]}
                  value={draft.plantId}
                  onChange={(value) => setDraft({ ...draft, plantId: value ?? 'all' })}
                  searchable={false}
                  cleanable={false}
                  block
                  container={() => containerRef.current ?? document.body}
                />
              </div>
              <div className="block space-y-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('filters.equipmentClass')}</span>
                <SelectPicker
                  data={[{ label: t('filters.allClasses'), value: 'all' }, ...classes.map((c) => ({ label: c, value: c }))]}
                  value={draft.classSlug}
                  onChange={(value) => setDraft({ ...draft, classSlug: value ?? 'all' })}
                  searchable={false}
                  cleanable={false}
                  block
                  container={() => containerRef.current ?? document.body}
                />
              </div>
              {showConnection && <div className="block space-y-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('filters.connectionStatus')}</span>
                <SelectPicker
                  data={[
                    { label: t('filters.allConnections'), value: 'all' },
                    { label: t('connection.online'), value: 'online' },
                    { label: t('connection.offline'), value: 'offline' },
                  ]}
                  value={draft.connection}
                  onChange={(value) => setDraft({ ...draft, connection: (value ?? 'all') as EquipmentConnection })}
                  searchable={false}
                  cleanable={false}
                  block
                  container={() => containerRef.current ?? document.body}
                />
              </div>}
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('filters.findEquipment')}</span>
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 z-10" />
                  <Input
                    value={draft.query}
                    onChange={(value) => setDraft({ ...draft, query: value })}
                    placeholder={t('filters.findPlaceholder')}
                    className="pl-8!"
                  />
                </div>
              </label>
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800">
              <button onClick={clearAll} className="text-sm font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer">
                {t('filters.clear')}
              </button>
              <button onClick={applyDraft} className="px-5 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold cursor-pointer">
                {t('filters.apply')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
