import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ChevronRight, FileCheck2, HardHat, Lock, Plus, Siren } from 'lucide-react';
import { usePageHeader } from '../lib/PageHeaderContext';
import { EvidenceRecordCard, EvidenceRecordForm } from '../components/shield/EvidenceRecord';
import { Modal } from '../components/common/Modal';
import { Chip } from '../components/common/Chip';
import {
  ApiError, SHIELD_CATEGORIES, ShieldCategory, ShieldEvidence, ShieldEvidenceInput, ShieldMachine, ShieldStatus,
  apiGetShieldSummary, apiListShieldRecords, apiRecordShieldEvidence, apiReviseShieldEvidence,
} from '../lib/api';

const CATEGORY_ICON: Record<ShieldCategory, React.FC<{ className?: string }>> = {
  compliance: FileCheck2, safety: HardHat, security: Lock,
};

const STATUS_TONE: Record<ShieldStatus, 'emerald' | 'amber' | 'rose' | 'slate'> = {
  current: 'emerald', due_soon: 'amber', overdue: 'rose', action_required: 'rose', not_recorded: 'slate',
};

export const ThingsShieldDetailPage: React.FC = () => {
  const { sourceSystem, externalId } = useParams<{ sourceSystem: string; externalId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation('shield');
  const [shield, setShield] = useState<ShieldMachine | null>(null);
  const [records, setRecords] = useState<ShieldEvidence[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [category, setCategory] = useState<ShieldCategory>('compliance');
  const [adding, setAdding] = useState(false);
  const [correcting, setCorrecting] = useState<ShieldEvidence | null>(null);

  usePageHeader({
    title: shield?.machine.name ?? externalId ?? t('detail.notFoundTitle'),
    subtitle: t('detail.subtitle'),
    onBack: () => navigate('/things-shield'),
  });

  // Status comes from the summary (it is computed there, with the due-soon window);
  // the history from the machine's own records. Both are re-read after every write, so
  // what is shown is always what the backend would now say.
  const load = async () => {
    if (!sourceSystem || !externalId) return;
    try {
      const [summary, list] = await Promise.all([apiGetShieldSummary(), apiListShieldRecords(sourceSystem, externalId)]);
      const mine = summary.machines.find((m) => m.machine.sourceSystem === sourceSystem && m.machine.externalId === externalId) ?? null;
      setShield(mine);
      setNotFound(!mine);
      setRecords(list);
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('detail.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { setLoading(true); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sourceSystem, externalId]);

  async function save(input: ShieldEvidenceInput) {
    if (!sourceSystem || !externalId) return;
    if (correcting) await apiReviseShieldEvidence(correcting.id, input);
    else await apiRecordShieldEvidence(sourceSystem, externalId, { ...input, category });
    setAdding(false);
    setCorrecting(null);
    await load();
  }

  if (loading) return <p className="text-sm text-slate-500">{t('page.loading')}</p>;
  if (notFound || !shield) {
    return (
      <div className="space-y-3">
        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        <p className="text-sm text-slate-500">{t('detail.notFound')}</p>
      </div>
    );
  }

  const cell = shield.categories[category];
  const categoryRecords = records.filter((r) => r.category === category);
  const others = categoryRecords.filter((r) => r.id !== cell.record?.id);

  return (
    <div className="space-y-3">
      <div className="bg-gradient-to-r from-sky-600 to-cyan-600 rounded-xl p-6 text-white space-y-1">
        <span className="text-xs font-semibold tracking-wider uppercase text-sky-100">{t('page.eyebrow')}</span>
        <h2 className="text-xl font-bold">{t('page.heading')}</h2>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /><span>{error}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {SHIELD_CATEGORIES.map((c) => {
          const Icon = CATEGORY_ICON[c];
          return (
            <button
              key={c}
              onClick={() => { setCategory(c); setAdding(false); setCorrecting(null); }}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg cursor-pointer ${category === c ? 'bg-sky-600 text-white' : 'border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}
            >
              <Icon className="w-4 h-4" /> {t(`category.${c}`)}
              <span className={`ml-1 w-2 h-2 rounded-full ${{ emerald: 'bg-emerald-400', amber: 'bg-amber-400', rose: 'bg-rose-500', slate: 'bg-slate-300' }[STATUS_TONE[shield.categories[c].status]]}`} />
            </button>
          );
        })}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-900 dark:text-white text-base truncate">{shield.machine.name ?? shield.machine.externalId}</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400 truncate">
            {shield.machine.sourceSystem}/{shield.machine.externalId}{shield.machine.classSlug ? ` · ${shield.machine.classSlug}` : ''}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="font-semibold text-slate-800 dark:text-slate-100 text-base">{t(`category.${category}`)}</h4>
          <Chip tone={STATUS_TONE[cell.status]} size="md">{t(`status.${cell.status}`)}</Chip>
          <span className="text-[11px] text-slate-400">
            {t('detail.dueSoonWindow', { count: shield.dueSoonWindow.days, source: shield.dueSoonWindow.source === 'default' ? t('detail.windowDefault') : t('detail.windowParameter') })}
          </span>
        </div>

        {cell.record ? (
          <EvidenceRecordCard record={cell.record} status={cell.status} onCorrect={() => setCorrecting(cell.record)} />
        ) : (
          <p className="text-sm text-slate-400">{t(`detail.noRecord.${category}`)}</p>
        )}

        <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-sky-300 cursor-pointer">
          <Plus className="w-4 h-4" /> {t(`detail.addRecord.${category}`)}
        </button>

        {others.length > 0 && (
          <div className="space-y-2 pt-3 border-t border-slate-100 dark:border-slate-800">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t('detail.history')}</p>
            {others.map((r) => (
              <EvidenceRecordCard key={r.id} record={r} onCorrect={() => setCorrecting(r)} />
            ))}
          </div>
        )}
      </div>

      <button
        onClick={() => navigate('/incident-management')}
        className="w-full flex items-center justify-between gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs hover:border-sky-300 cursor-pointer text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
          <Siren className="w-4 h-4 text-amber-500" /> {t('page.incidentsLink')}
        </span>
        <ChevronRight className="w-4 h-4 text-slate-400" />
      </button>

      <Modal
        isOpen={adding || correcting !== null}
        onClose={() => { setAdding(false); setCorrecting(null); }}
        title={correcting ? t('detail.correctRecord') : t(`detail.addRecord.${category}`)}
        maxWidth="max-w-lg"
      >
        <EvidenceRecordForm
          key={correcting?.id ?? `new-${category}`}
          initial={correcting ?? undefined}
          onCancel={() => { setAdding(false); setCorrecting(null); }}
          onSave={save}
        />
      </Modal>
    </div>
  );
};
