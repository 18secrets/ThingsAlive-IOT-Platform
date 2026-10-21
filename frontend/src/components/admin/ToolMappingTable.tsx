import React, { useState, useMemo } from 'react';
import { Search, Plus, Edit3, AlertCircle, Trash2 } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { ApiError, IndustryType, Sensor, ToolMapping, ToolMappingInput } from '../../lib/api';
import { MapSensorsModal } from './MapSensorsModal';
import { TablePagination, usePagination } from '../common/TablePagination';

interface ToolMappingTableProps {
  mappings: ToolMapping[];
  error?: string;
  onCreateMapping: (input: ToolMappingInput) => Promise<ToolMapping>;
  onUpdateMapping: (id: string, input: ToolMappingInput) => Promise<ToolMapping>;
  onDeleteMapping: (id: string) => Promise<void>;
  availableSensors: Sensor[];
  industryTypes: IndustryType[];
}

export const ToolMappingTable: React.FC<ToolMappingTableProps> = ({
  mappings, error, onCreateMapping, onUpdateMapping, onDeleteMapping, availableSensors, industryTypes,
}) => {
  const { t } = useTranslation('catalog');
  const [searchTerm, setSearchTerm] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  const handleDelete = async (item: ToolMapping) => {
    if (!window.confirm(t('toolMappings.confirmDelete', { name: item.toolName }))) return;
    setDeletingId(item.id);
    setDeleteError(undefined);
    try {
      await onDeleteMapping(item.id);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : t('toolMappings.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  };
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState<ToolMapping | null>(null);
  // 'all', 'none' (no industry type set), or an industry type id.
  const [industryFilter, setIndustryFilter] = useState('all');

  const filteredMappings = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return mappings.filter((item) => (
      item.toolName.toLowerCase().includes(term) ||
      (item.industryType?.toLowerCase().includes(term) ?? false)
    ) && (
      industryFilter === 'all'
      || (industryFilter === 'none' ? !item.industryTypeId : item.industryTypeId === industryFilter)
    ));
  }, [mappings, searchTerm, industryFilter]);

  const { pageItems: pagedRows, ...pager } = usePagination(filteredMappings);

  return (
    <div id="tool-mapping-view" className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={searchTerm}
              onChange={(value) => setSearchTerm(value)}
              placeholder={t('toolMappings.searchPlaceholder')}
              size="sm"
              className="w-full pl-9!"
            />
          </div>
          <SelectPicker
            data={[
              { label: t('toolMappings.allIndustryTypes'), value: 'all' },
              { label: t('toolMappings.noIndustryType'), value: 'none' },
              ...industryTypes.map((it) => ({ label: it.status === 'active' ? it.name : t('toolMappings.inactive', { name: it.name }), value: it.id })),
            ]}
            value={industryFilter}
            onChange={(v) => setIndustryFilter(v ?? 'all')}
            cleanable={false}
            size="sm"
            className="w-52"
          />
        </div>

        <button
          id="create-mapping-btn"
          onClick={() => { setEditingMapping(null); setIsModalOpen(true); }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t('toolMappings.create')}</span>
        </button>
      </div>

      {(error || deleteError) && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error || deleteError}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-4">{t('toolMappings.toolProfile')}</th>
                <th className="py-3 px-4">{t('toolMappings.industryType')}</th>
                <th className="py-3 px-4">{t('toolMappings.mappedSensors')}</th>
                <th className="py-3 px-4">{t('sensors.parameters')}</th>
                <th className="py-3 px-4">{t('sensors.updatedAt')}</th>
                <th className="py-3 px-4 text-center">{t('common.action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {pagedRows.map((item) => {
                const activeParametersCount = item.mappedSensors.reduce((acc, s) => acc + s.parameters.length, 0);
                return (
                  <tr key={item.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-sm text-slate-900 dark:text-white">{item.toolName}</div>
                    </td>
                    <td className="py-3.5 px-4 text-slate-600 dark:text-slate-400">
                      {item.industryType ?? (item.industryTypeLegacy ? (
                        <span className="text-amber-600 dark:text-amber-400" title={t('toolMappings.unmatchedHint')}>
                          {item.industryTypeLegacy} <span className="text-[10px]">{t('toolMappings.unmatched')}</span>
                        </span>
                      ) : '—')}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex flex-wrap gap-1.5 max-w-sm">
                        {item.mappedSensors.map((sensor) => (
                          <span
                            key={sensor.sensorId}
                            className="px-2 py-0.5 text-[11px] font-mono rounded bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800"
                            title={t('toolMappings.parametersTitle', { list: sensor.parameters.join(', ') })}
                          >
                            {sensor.sensorName}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-semibold text-[11px] border border-slate-200 dark:border-slate-700">
                        {t('toolMappings.channelsShort', { count: activeParametersCount })}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                      {new Date(item.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => { setEditingMapping(item); setIsModalOpen(true); }}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                          title={t('toolMappings.edit')}
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(item)}
                          disabled={deletingId === item.id}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 disabled:opacity-30 transition-colors cursor-pointer"
                          title={t('toolMappings.delete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="px-6 py-2 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-400 font-sans">
          {t('toolMappings.autoBind')}
        </div>
        <TablePagination {...pager} />
      </div>

      <MapSensorsModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingMapping(null); }}
        onCreate={onCreateMapping}
        onUpdate={onUpdateMapping}
        existingMapping={editingMapping}
        availableSensors={availableSensors}
        industryTypes={industryTypes}
      />
    </div>
  );
};
