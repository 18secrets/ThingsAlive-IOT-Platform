import React, { useState, useMemo } from 'react';
import { Search, Plus, Eye, Edit2, AlertCircle, ChevronsUpDown, Archive, RotateCcw, Trash2, Tags } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { ApiError, Sensor, SensorCategory, SensorInput } from '../../lib/api';
import { compareByCategoryOrder, sortByCategory } from '../../lib/sensorCategoryOrder';
import { AddSensorModal } from './AddSensorModal';
import { SensorDetailModal } from './SensorDetailModal';
import { ManageSensorCategoriesModal } from './ManageSensorCategoriesModal';
import { TablePagination, usePagination } from '../common/TablePagination';
import { ListTable } from '../common/ListTable';
import { RecordCards } from '../common/RecordCards';
import { ViewModeToggle, useViewMode } from '../common/ViewModeToggle';

interface SensorTableProps {
  sensors: Sensor[];
  error?: string;
  categories: SensorCategory[];
  showRetired: boolean;
  onToggleShowRetired: (next: boolean) => void;
  onCreateSensor: (input: SensorInput) => Promise<Sensor>;
  onUpdateSensor: (id: string, input: SensorInput) => Promise<Sensor>;
  onRetireSensor: (id: string) => Promise<Sensor>;
  onUnretireSensor: (id: string) => Promise<Sensor>;
  onDeleteSensor: (id: string) => Promise<void>;
  onCreateCategory: (name: string) => Promise<SensorCategory>;
  onRetireCategory: (id: string) => Promise<SensorCategory>;
  onUnretireCategory: (id: string) => Promise<SensorCategory>;
  onRenameCategory: (id: string, name: string) => Promise<SensorCategory>;
  onDeleteCategory: (id: string) => Promise<void>;
}

export const SensorTable: React.FC<SensorTableProps> = ({
  sensors, error, categories, showRetired, onToggleShowRetired,
  onCreateSensor, onUpdateSensor, onRetireSensor, onUnretireSensor, onDeleteSensor,
  onCreateCategory, onRetireCategory, onUnretireCategory, onDeleteCategory, onRenameCategory,
}) => {
  const { t } = useTranslation('catalog');
  const [viewMode, setViewMode] = useViewMode('admin-sensors');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingSensor, setEditingSensor] = useState<Sensor | null>(null);
  const [viewingSensor, setViewingSensor] = useState<Sensor | null>(null);
  const [isCategoriesModalOpen, setIsCategoriesModalOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const categoryName = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c.name]));
    return (id: string | null) => (id ? byId.get(id) ?? '—' : '—');
  }, [categories]);

  const filteredSensors = useMemo(() => {
    const filtered = sensors.filter((s) => {
      const name = categoryName(s.categoryId);
      const matchesSearch =
        s.sensorName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        name.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesCategory = selectedCategory === 'All' || s.categoryId === selectedCategory;
      return matchesSearch && matchesCategory;
    });
    return sortByCategory(filtered, (s) => categoryName(s.categoryId), (s) => s.sensorName);
  }, [sensors, searchTerm, selectedCategory, categoryName]);

  const { pageItems: pagedSensors, ...pager } = usePagination(filteredSensors);

  // One definition for both views (cards or list on every list page).
  const viewColumns = [
    { label: t('sensors.category') },
    { label: t('sensors.sensorName') },
    { label: t('sensors.parameters') },
    { label: t('common.statusHeader') },
    { label: t('sensors.updatedAt') },
    { label: t('common.view') },
    { label: t('common.actions'), width: 120 },
  ];
  const viewCells = (sensor: (typeof pagedSensors)[number]) => {
    const retired = !!sensor.retiredAt;
    return [
      <span className="font-normal">{categoryName(sensor.categoryId)}</span>,
      <span className="font-normal text-slate-800 dark:text-slate-200">{sensor.sensorName}</span>,
      <span className="text-slate-500 dark:text-slate-400 text-xs">{sensor.parameterSpecs.length}</span>,
      <><span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${
                        retired
                          ? 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                          : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                      }`}>
                        {retired ? t('common.statusLabel.retired') : t('sensors.live')}
                      </span></>,
      <span className="text-slate-500 dark:text-slate-400 text-xs">{new Date(sensor.updatedAt).toLocaleDateString()}</span>,
      <><button
                        onClick={() => setViewingSensor(sensor)}
                        className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors inline-flex items-center justify-center cursor-pointer"
                        title={t('sensors.viewDetails')}
                      >
                        <Eye className="w-4 h-4" />
                      </button></>,
      <><div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => { setEditingSensor(sensor); setIsAddModalOpen(true); }}
                          className="p-1 text-sky-600 hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300 transition-colors inline-flex items-center justify-center cursor-pointer"
                          title={t('sensors.editSensor')}
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => withBusy(sensor.id, () => (retired ? onUnretireSensor(sensor.id) : onRetireSensor(sensor.id)))}
                          disabled={busyId === sensor.id}
                          className="p-1 text-slate-500 hover:text-amber-600 dark:hover:text-amber-400 transition-colors inline-flex items-center justify-center cursor-pointer disabled:opacity-50"
                          title={retired ? t('sensors.unretireHint') : t('sensors.retireHint')}
                        >
                          {retired ? <RotateCcw className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          onClick={() => withBusy(sensor.id, () => onDeleteSensor(sensor.id))}
                          disabled={busyId === sensor.id}
                          className="p-1 text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 transition-colors inline-flex items-center justify-center cursor-pointer disabled:opacity-50"
                          title={t('sensors.deleteHint')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div></>,
    ];
  };

  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => compareByCategoryOrder(a.name, b.name)),
    [categories],
  );

  const categoryOptions = useMemo(
    () => [
      { label: t('sensors.filterByCategory'), value: 'All' },
      ...sortedCategories.map((c) => ({ label: c.name, value: c.id })),
    ],
    [sortedCategories, t],
  );

  const withBusy = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setActionError(undefined);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('common.actionFailed'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div id="sensor-management-view" className="space-y-4">
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={searchTerm}
              onChange={(value) => setSearchTerm(value)}
              placeholder={t('sensors.searchPlaceholder')}
              size="sm"
              className="w-full pl-9!"
            />
          </div>

          <SelectPicker
            data={categoryOptions}
            value={selectedCategory}
            onChange={(value) => setSelectedCategory(value ?? 'All')}
            size="sm"
            searchable={categoryOptions.length > 6}
            cleanable={false}
          />

          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showRetired}
              onChange={(e) => onToggleShowRetired(e.target.checked)}
              className="accent-sky-600"
            />
            {t('common.showRetired')}
          </label>

          <button
            onClick={() => setIsCategoriesModalOpen(true)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-xs font-semibold hover:border-sky-300 hover:text-sky-600 transition-colors flex items-center gap-1.5 cursor-pointer"
            title={t('sensors.manageCategories')}
          >
            <Tags className="w-3.5 h-3.5" />
            {t('sensors.categories')}
          </button>
        </div>

        <div className="flex items-center gap-3 shrink-0">
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        <button
          id="add-sensor-btn"
          onClick={() => { setEditingSensor(null); setIsAddModalOpen(true); }}
          className="px-4 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t('sensors.addSensor')}</span>
        </button>
        </div>
      </div>

      {(error || actionError) && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error ?? actionError}</span>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden shadow-xs">
        {filteredSensors.length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-sm">{t('sensors.noMatch')}</div>
        ) : viewMode === 'list' ? (
          <ListTable bare columns={viewColumns} rows={pagedSensors} rowKey={(sensor) => sensor.id} cells={viewCells} />
        ) : (
          <div className="p-4"><RecordCards columns={viewColumns} rows={pagedSensors} rowKey={(sensor) => sensor.id} cells={viewCells} actionsIndex={6} /></div>
        )}

        <TablePagination pinToBottom {...pager} />
      </div>

      <AddSensorModal
        isOpen={isAddModalOpen}
        onClose={() => { setIsAddModalOpen(false); setEditingSensor(null); }}
        onCreate={onCreateSensor}
        onUpdate={onUpdateSensor}
        categories={categories.filter((c) => !c.retiredAt || c.id === editingSensor?.categoryId)}
        onCreateCategory={onCreateCategory}
        existingSensor={editingSensor}
      />

      <SensorDetailModal
        sensor={viewingSensor}
        categoryName={viewingSensor ? categoryName(viewingSensor.categoryId) : undefined}
        onClose={() => setViewingSensor(null)}
      />

      <ManageSensorCategoriesModal
        isOpen={isCategoriesModalOpen}
        onClose={() => setIsCategoriesModalOpen(false)}
        categories={categories}
        showRetired={showRetired}
        onToggleShowRetired={onToggleShowRetired}
        onRetire={onRetireCategory}
        onUnretire={onUnretireCategory}
        onDelete={onDeleteCategory}
        onRename={onRenameCategory}
      />
    </div>
  );
};
