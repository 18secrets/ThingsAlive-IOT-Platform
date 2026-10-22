import React, { useState, useMemo } from 'react';
import {
  Search,
  Plus,
  AlertCircle,
  Edit2,
  Trash2,
  MapPin,
  LayoutDashboard,
  Hexagon,
} from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import {
  ApiError, GeoJsonPolygon, IndustryType, IndustryTypeInput, Plant, PlantInput, UnmatchedIndustry,
} from '../../lib/api';
import { TablePagination, usePagination } from '../common/TablePagination';
import { AddIndustryTypeModal } from './AddIndustryTypeModal';
import { AddPlantModal } from './AddPlantModal';
import { EditPlantBoundaryModal } from './EditPlantBoundaryModal';

interface IndustryTypeViewProps {
  items: IndustryType[];
  error?: string;
  /** Free text from before industry types existed that no active type matches yet. */
  unmatched: UnmatchedIndustry[];
  onCreateIndustryType?: (input: IndustryTypeInput & { name: string; code: string }) => Promise<void>;
  onUpdateIndustryType?: (id: string, input: IndustryTypeInput) => Promise<void>;
  onDeleteIndustryType?: (id: string) => Promise<void>;
  onRematchIndustries?: () => Promise<{ matched: number; unmatched: number }>;
}

export const IndustryTypeView: React.FC<IndustryTypeViewProps> = ({
  items,
  error,
  unmatched,
  onCreateIndustryType,
  onUpdateIndustryType,
  onDeleteIndustryType,
  onRematchIndustries,
}) => {
  const { t } = useTranslation('equipment');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | IndustryType['status']>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<IndustryType | null>(null);
  // Bumped on every open so the modal remounts and reads the item it was opened for.
  const [modalKey, setModalKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rematching, setRematching] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const filteredItems = useMemo(() => {
    return items.filter((i) => (
      i.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      i.code.toLowerCase().includes(searchTerm.toLowerCase())
    ) && (statusFilter === 'all' || i.status === statusFilter));
  }, [items, searchTerm, statusFilter]);

  const openModal = (item: IndustryType | null) => {
    setEditingItem(item);
    setModalKey((k) => k + 1);
    setIsModalOpen(true);
  };

  const handleDelete = async (item: IndustryType) => {
    if (!window.confirm(t('industry.deleteConfirm', { name: item.name }))) return;
    setBusyId(item.id);
    try {
      await onDeleteIndustryType?.(item.id);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t('industry.deleteFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const handleRematch = async () => {
    if (!onRematchIndustries) return;
    setRematching(true);
    setNotice(undefined);
    try {
      const { matched, unmatched: left } = await onRematchIndustries();
      setNotice(left
        ? t('industry.rematchedSome', { matched: t('industry.mappingsMatched', { count: matched }), left: t('industry.stillNeedType', { count: left }) })
        : t('industry.rematchedAll', { matched: t('industry.mappingsMatched', { count: matched }) }));
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : t('industry.rematchFailed'));
    } finally {
      setRematching(false);
    }
  };

  const unmatchedMappings = unmatched.reduce((sum, u) => sum + u.mappings, 0);

  const { pageItems: pagedItems, ...pager } = usePagination(filteredItems);

  return (
    <div id="industry-type-management-view" className="space-y-3">

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Search & Add Action Bar */}
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
        {/* Filters stay together on the left; actions sit on the right. */}
        <div className="flex flex-1 flex-col sm:flex-row sm:items-center gap-3 w-full min-w-0">
        <div className="relative flex-1 w-full max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            value={searchTerm}
            onChange={(value) => setSearchTerm(value)}
            placeholder={t('industry.searchPlaceholder')}
            size="sm"
            className="w-full pl-9!"
          />
        </div>
        <SelectPicker
          data={[{ label: t('common.allStatuses'), value: 'all' }, { label: t('status.active'), value: 'active' }, { label: t('status.inactive'), value: 'inactive' }]}
          value={statusFilter}
          onChange={(v) => setStatusFilter((v ?? 'all') as typeof statusFilter)}
          searchable={false}
          cleanable={false}
          size="sm"
          className="w-full sm:w-40"
        />
        </div>

        {onCreateIndustryType && (
          <button
            id="add-industry-type-btn"
            onClick={() => openModal(null)}
            className="w-full sm:w-auto px-5 py-2.5 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>{t('industry.add')}</span>
          </button>
        )}
      </div>

      {/* Tool mappings saved before industry types existed carry free text. It is kept,
          not discarded, and re-matched to a real type once one with that name exists. */}
      {(unmatchedMappings > 0 || notice) && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl p-4 space-y-2">
          {unmatchedMappings > 0 && (
            <>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                  {t('industry.unmatched', { count: unmatchedMappings })}
                </p>
                {onRematchIndustries && (
                  <button
                    onClick={handleRematch}
                    disabled={rematching}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950 disabled:opacity-50 cursor-pointer"
                  >
                    {rematching ? t('industry.rematching') : t('industry.rematch')}
                  </button>
                )}
              </div>
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                {t('industry.unmatchedHint')}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {unmatched.map((u) => (
                  <span key={u.text} className="text-[11px] font-medium px-2 py-0.5 rounded bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300">
                    {u.text} <span className="text-amber-500">×{u.mappings}</span>
                  </span>
                ))}
              </div>
            </>
          )}
          {notice && <p className="text-[11px] text-amber-800 dark:text-amber-300">{notice}</p>}
        </div>
      )}

      {/* Industry Type Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {pagedItems.map((item) => (
          <div
            key={item.id}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex flex-col justify-between hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-4"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 px-2 py-0.5 rounded border border-sky-200 dark:border-sky-800">
                  #{item.code}
                </span>

                <div className="flex items-center gap-1.5">
                  {onUpdateIndustryType && (
                    <button
                      onClick={() => openModal(item)}
                      disabled={busyId === item.id}
                      className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer disabled:opacity-50"
                      title={t('industry.edit')}
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {onDeleteIndustryType && (
                    <button
                      onClick={() => handleDelete(item)}
                      disabled={busyId === item.id}
                      className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer disabled:opacity-50"
                      title={t('industry.delete')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <h4 className="font-semibold text-slate-900 dark:text-white text-base leading-snug">
                {item.name}
              </h4>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {t('industry.created', { date: new Date(item.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) })}
              </p>
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end text-xs text-slate-500 dark:text-slate-400">
              <span className={`font-semibold text-xs ${item.status === 'active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}>
                • {item.status === 'active' ? t('status.active') : t('status.inactive')}
              </span>
            </div>
          </div>
        ))}

        {filteredItems.length === 0 && (
          <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
            <span>{t('industry.empty')}</span>
          </div>
        )}
      </div>
      {filteredItems.length > 0 && <TablePagination bare {...pager} />}

      <AddIndustryTypeModal
        key={modalKey}
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingItem(null);
        }}
        onSave={async (input) => {
          if (editingItem) await onUpdateIndustryType?.(editingItem.id, input);
          else await onCreateIndustryType?.(input);
        }}
        existingIndustryType={editingItem}
      />
    </div>
  );
};

interface PlantViewProps {
  plants: Plant[];
  error?: string;
  onCreatePlant: (input: PlantInput) => Promise<Plant>;
  onUpdatePlant: (id: string, input: Partial<PlantInput>) => Promise<Plant>;
  onToggleStatus: (id: string, currentStatus: Plant['status']) => void;
  onOpenSitePage: (plantId: string) => void;
  onSetPlantBoundary: (id: string, boundary: GeoJsonPolygon | null) => Promise<Plant>;
}

export const PlantView: React.FC<PlantViewProps> = ({
  plants, error, onCreatePlant, onUpdatePlant, onToggleStatus, onOpenSitePage, onSetPlantBoundary,
}) => {
  const { t } = useTranslation('equipment');
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingPlant, setEditingPlant] = useState<Plant | null>(null);
  const [boundaryPlant, setBoundaryPlant] = useState<Plant | null>(null);

  const filteredItems = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return plants.filter((p) =>
      p.name.toLowerCase().includes(term) ||
      p.code.toLowerCase().includes(term) ||
      (p.address?.toLowerCase().includes(term) ?? false)
    );
  }, [plants, searchTerm]);

  const { pageItems: pagedItems, ...pager } = usePagination(filteredItems);

  return (
    <div id="plant-management-view" className="space-y-3">

      {/* Search & Add Action Bar */}
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative flex-1 w-full max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            value={searchTerm}
            onChange={(value) => setSearchTerm(value)}
            placeholder={t('plants.searchPlaceholder')}
            size="sm"
            className="w-full pl-9!"
          />
        </div>

        <button
          id="add-plant-btn"
          onClick={() => {
            setEditingPlant(null);
            setIsModalOpen(true);
          }}
          className="w-full sm:w-auto px-5 py-2.5 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t('plants.add')}</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Plant Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {pagedItems.map((plant) => (
          <div
            key={plant.id}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex flex-col justify-between hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-4"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 px-2 py-0.5 rounded border border-sky-200 dark:border-sky-800">
                  #{plant.code}
                </span>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => onToggleStatus(plant.id, plant.status)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer ${
                      plant.status === 'active' ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'
                    }`}
                    title={plant.status === 'active' ? t('plants.retireSite') : t('plants.reopenSite')}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        plant.status === 'active' ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>

                  <button
                    onClick={() => {
                      setEditingPlant(plant);
                      setIsModalOpen(true);
                    }}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                    title={t('plants.edit')}
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <h4 className="font-semibold text-slate-900 dark:text-white text-base leading-snug">
                {plant.name}
              </h4>
              {plant.address && (
                <p className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1">
                  <MapPin className="w-3 h-3 text-rose-500" />
                  {plant.address}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => onOpenSitePage(plant.id)}
                className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 text-[11px] font-semibold hover:bg-sky-100 dark:hover:bg-sky-950/70 transition-colors cursor-pointer"
              >
                <LayoutDashboard className="w-3.5 h-3.5" />
                <span>{t('plants.sitePage')}</span>
              </button>
              <button
                onClick={() => setBoundaryPlant(plant)}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-[11px] font-semibold transition-colors cursor-pointer ${
                  plant.boundary
                    ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/70'
                    : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                }`}
                title={plant.boundary ? t('plants.boundarySetTitle') : t('plants.noBoundaryTitle')}
              >
                <Hexagon className="w-3.5 h-3.5" />
                <span>{plant.boundary ? t('plants.boundarySet') : t('plants.setBoundary')}</span>
              </button>
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end text-xs text-slate-500 dark:text-slate-400">
              <span className={`font-semibold text-xs ${plant.status === 'active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}>
                • {plant.status === 'active' ? t('status.active') : t('status.retired')}
              </span>
            </div>
          </div>
        ))}

        {filteredItems.length === 0 && (
          <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
            <span>{t('plants.empty')}</span>
          </div>
        )}
      </div>
      {filteredItems.length > 0 && <TablePagination bare {...pager} />}

      {/* No delete here — the API only ever retires a site, since anything
          that once stood there (work orders, alerts) still needs it to exist. */}
      <AddPlantModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingPlant(null);
        }}
        onCreate={onCreatePlant}
        onUpdate={onUpdatePlant}
        existingPlant={editingPlant}
      />

      <EditPlantBoundaryModal
        isOpen={!!boundaryPlant}
        onClose={() => setBoundaryPlant(null)}
        plant={boundaryPlant}
        onSave={onSetPlantBoundary}
      />
    </div>
  );
};
