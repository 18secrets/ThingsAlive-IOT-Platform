import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { ApiError, ClassFuelFigures, apiGetClassFuelFigures } from '../../../lib/api';
import { PanelRow, PanelRows } from '../../common/PanelRow';

const SECTION = 'text-xs font-semibold uppercase tracking-wide text-slate-500';

/**
 * A class version's fuel figures (D55), for whoever loads them. Every machine's expected
 * litres per shift said "can't be worked out yet" and nothing showed which figure was
 * missing, or that the class held none (fuel test report follow-up, 4 Nov). This lists
 * each figure as stored, says what is still missing in the same words a machine's Fuel
 * per shift panel uses, and where they are loaded. Read-only: they come in through the
 * catalog workbook with their datasheet, never typed in here.
 */
export const ClassFuelFiguresPanel: React.FC<{ slug: string; version: number }> = ({ slug, version }) => {
  // The blocker sentences are the machine panel's own (equipment.json), so both namespaces.
  const { t } = useTranslation(['catalog', 'equipment']);
  const [data, setData] = useState<ClassFuelFigures | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(undefined);
    apiGetClassFuelFigures(slug, version)
      .then((d) => { if (live) setData(d); })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : t('classFuel.loadFailed')); });
    return () => { live = false; };
  }, [slug, version, t]);

  if (error) return <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  if (!data) return <p className="text-sm text-slate-500">{t('classFuel.loading')}</p>;

  const f = data.figures;
  const value = (v: number | null, unit: string) =>
    v == null
      ? <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{t('classFuel.notSet')}</span>
      : <span className="font-mono text-sm text-slate-800 dark:text-slate-100">{v} {unit}</span>;
  const rows: { key: string; label: string; v: number | null; unit: string; note?: string | null }[] = [
    { key: 'rated', label: t('classFuel.figure.ratedPowerKw'), v: f.ratedPowerKw, unit: 'kW' },
    { key: 'load', label: t('classFuel.figure.workingLoadPct'), v: f.workingLoadPct, unit: '%' },
    { key: 'bsfc', label: t('classFuel.figure.bsfcGPerKwh'), v: f.bsfcGPerKwh, unit: 'g/kWh', note: f.bsfcSource },
    { key: 'nominal', label: t('classFuel.figure.nominalFuelPerHour'), v: f.nominalFuelPerHour, unit: f.nominalFuelUnit ?? 'L/h', note: f.nominalFuelSource },
    { key: 'idle', label: t('classFuel.figure.idleFuelPerHour'), v: f.idleFuelPerHour, unit: 'L/h' },
    { key: 'share', label: t('classFuel.figure.workingShare'), v: f.workingShare, unit: '' },
  ];

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('classFuel.title', { version: data.classVersion })}</p>
        <p className="text-xs text-slate-500">{t('classFuel.lead')}</p>
      </div>

      {data.blockedBy.length === 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" />
          <span>{t('classFuel.ready', { source: data.workingRateFrom === 'bsfc' ? t('classFuel.fromBsfc') : t('classFuel.fromNominal') })}</span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          <div>
            <p>{t('classFuel.blocked')}</p>
            <ul className="list-disc pl-4">
              {data.blockedBy.map((b) => <li key={b}>{t(`equipment:fuelPerShift.blocker.${b}`)}</li>)}
            </ul>
          </div>
        </div>
      )}

      <section className="space-y-1">
        <p className={SECTION}>{t('classFuel.figures')}</p>
        <PanelRows>
          {rows.map((r) => (
            <PanelRow
              key={r.key}
              title={r.label}
              detail={r.note ? t('classFuel.source', { source: r.note }) : (r.key === 'bsfc' || r.key === 'nominal') && r.v != null ? t('classFuel.noSource') : undefined}
              right={value(r.v, r.unit)}
            />
          ))}
        </PanelRows>
      </section>

      <section className="space-y-1">
        <p className={SECTION}>{t('classFuel.howTitle')}</p>
        <p className="text-xs text-slate-600 dark:text-slate-300 font-mono">{t('classFuel.formula')}</p>
        <p className="text-xs text-slate-500">{t('classFuel.howLoad', { page: t('import.title') })}</p>
      </section>
    </div>
  );
};
