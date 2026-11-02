import React from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CsvCell, downloadCsv } from '../../lib/csv';

/** Exports the rows handed to it — the list as filtered, every page of it, not just the one on screen. */
export const ExportCsvButton: React.FC<{
  name: string; headers: string[]; rows: () => CsvCell[][]; disabled?: boolean;
}> = ({ name, headers, rows, disabled }) => {
  const { t } = useTranslation('shared');
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => downloadCsv(name, headers, rows())}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:border-sky-300 disabled:opacity-50 cursor-pointer shrink-0"
      title={t('export.title')}
    >
      <Download className="w-3.5 h-3.5" /> {t('export.csv')}
    </button>
  );
};
