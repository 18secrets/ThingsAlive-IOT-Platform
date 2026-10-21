import React, { useEffect, useState, useMemo } from 'react';
import { Search, Sparkles, ChevronLeft, ChevronRight } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { ApiError, Workflow, WorkflowVersion, apiListWorkflows, apiRetireWorkflow } from '../../lib/api';
import { WorkflowDraft } from '../../utils/workflowParser';
import { specSignals } from '../alerts/workflow/workflowGraph';

type RowStatus = 'Deployed' | 'Draft' | 'Disabled';

interface AlertRuleRow {
  workflow: Workflow;
  /** The version a click opens: the draft if one exists, else the newest. */
  open: WorkflowVersion;
  status: RowStatus;
  /** A draft waiting beside a published version, by number. */
  pendingDraft: number | null;
  sensors: string[];
  conditions: string[];
  rulesOff: number;
}

/**
 * One row per workflow. "Deployed" while any version is published (its rules run);
 * "Draft" when none ever was; "Disabled" once retired. A new draft of a published
 * workflow does not change what runs, so it shows beside "Deployed" rather than over it.
 */
function toRow(wf: Workflow): AlertRuleRow | null {
  const newest = wf.versions[wf.versions.length - 1];
  if (!newest) return null;
  const published = wf.versions.find((v) => v.status === 'published');
  const draft = wf.versions.find((v) => v.status === 'draft');
  const shown = published ?? newest;
  return {
    workflow: wf,
    open: draft ?? newest,
    status: published ? 'Deployed' : newest.status === 'draft' ? 'Draft' : 'Disabled',
    pendingDraft: published && draft ? draft.version : null,
    sensors: specSignals(shown.spec),
    conditions: shown.rendering,
    rulesOff: published ? published.rules.filter((r) => !r.enabled).length : 0,
  };
}

const STATUS_STYLES: Record<RowStatus, string> = {
  Deployed: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  Draft: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  Disabled: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
};

const STATUS_DOT: Record<RowStatus, string> = {
  Deployed: 'bg-emerald-500',
  Draft: 'bg-amber-500',
  Disabled: 'bg-slate-400',
};

interface AlertAgentViewProps {
  // "+ Add Alert" hands off to the AI Onboarding assistant rather than a
  // manual form — alert rules here are authored the same way devices are,
  // through the chat-driven setup flow.
  onAddAlert: () => void;
  /** Opens a stored workflow in the editor. */
  onOpen: (draft: WorkflowDraft) => void;
}

export const AlertAgentView: React.FC<AlertAgentViewProps> = ({ onAddAlert, onOpen }) => {
  const { t } = useTranslation('alerts');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('All');
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<string | null>(null);

  const load = () => apiListWorkflows()
    .then((list) => { setWorkflows(list); setError(null); })
    .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  useEffect(() => { load(); }, []);

  const retire = async (wf: Workflow) => {
    if (!window.confirm(t('agentList.retireConfirm', { name: wf.name }))) return;
    setRetiring(wf.id);
    try {
      await apiRetireWorkflow(wf.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRetiring(null);
    }
  };

  const rows = useMemo(() => (workflows ?? []).map(toRow).filter((r): r is AlertRuleRow => !!r), [workflows]);

  const filteredRules = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return rows.filter((rule) => {
      const matchesSearch =
        !term ||
        rule.workflow.name.toLowerCase().includes(term) ||
        rule.workflow.slug.includes(term) ||
        (rule.workflow.description ?? '').toLowerCase().includes(term) ||
        rule.sensors.some((s) => s.toLowerCase().includes(term)) ||
        rule.conditions.some((c) => c.toLowerCase().includes(term));
      const matchesStatus = selectedStatus === 'All' || rule.status === selectedStatus;
      return matchesSearch && matchesStatus;
    });
  }, [rows, searchTerm, selectedStatus]);

  const totalRows = filteredRules.length;
  const totalPages = Math.ceil(totalRows / rowsPerPage) || 1;
  const startIndex = (currentPage - 1) * rowsPerPage;
  const paginatedRules = filteredRules.slice(startIndex, startIndex + rowsPerPage);

  return (
    <div id="alert-agent-view" className="space-y-4">
      {/* Filter Row & Action — matches Device Management's filter bar */}
      <div className="bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">

        <div className="flex flex-1 items-center gap-3 flex-wrap">
          {/* Search */}
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 z-10" />
            <Input
              value={searchTerm}
              onChange={(value) => {
                setSearchTerm(value);
                setCurrentPage(1);
              }}
              placeholder={t('agentList.searchPlaceholder')}
              size="sm"
              className="pl-9!"
            />
          </div>

          {/* Status Filter */}
          <SelectPicker
            data={[
              { label: t('agentList.allStatuses'), value: 'All' },
              { label: t('agentList.status.Deployed'), value: 'Deployed' },
              { label: t('agentList.status.Draft'), value: 'Draft' },
              { label: t('agentList.status.Disabled'), value: 'Disabled' },
            ]}
            value={selectedStatus}
            onChange={(value) => {
              setSelectedStatus(value ?? 'All');
              setCurrentPage(1);
            }}
            searchable={false}
            cleanable={false}
            size="sm"
          />
        </div>

        {/* Add Alert — hands off to the AI Onboarding assistant, same as "Setup with AI" on Devices */}
        <button
          id="add-alert-btn"
          onClick={onAddAlert}
          className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Sparkles className="w-4 h-4" />
          <span>{t('agentList.addAlert')}</span>
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">{error}</div>
      )}

      {/* Main Table — matches Device Management's table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-4 text-center">{t('agentList.columns.id')}</th>
                <th className="py-3 px-4">{t('agentList.columns.workflowName')}</th>
                <th className="py-3 px-4 min-w-[260px]">{t('agentList.columns.description')}</th>
                <th className="py-3 px-4">{t('agentList.columns.status')}</th>
                <th className="py-3 px-4">{t('agentList.columns.sensors')}</th>
                <th className="py-3 px-4 min-w-[220px]">{t('agentList.columns.conditions')}</th>
                <th className="py-3 px-4" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {paginatedRules.length > 0 ? (
                paginatedRules.map((rule) => (
                  <tr
                    key={rule.workflow.id}
                    onClick={() => onOpen({
                      name: rule.workflow.name, spec: rule.open.spec, workflowId: rule.workflow.id,
                      version: rule.open.version, status: rule.open.status, layout: rule.open.layout,
                    })}
                    className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors align-top cursor-pointer"
                  >
                    <td className="py-3 px-4 text-center font-mono font-medium text-slate-400 text-[11px]">
                      {rule.workflow.slug}
                    </td>
                    <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white max-w-[220px] break-words">
                      {rule.workflow.name}
                    </td>
                    <td className="py-3 px-4 font-normal text-slate-600 dark:text-slate-400 max-w-[320px]">
                      {rule.workflow.description}
                    </td>
                    <td className="py-3 px-4 space-y-1">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATUS_STYLES[rule.status]}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${STATUS_DOT[rule.status]}`}></span>
                        {t(`agentList.status.${rule.status}`, { defaultValue: rule.status })}
                      </span>
                      {rule.pendingDraft != null && (
                        <div className="text-[10px] text-amber-600 dark:text-amber-400">{t('agentList.pendingDraft', { version: rule.pendingDraft })}</div>
                      )}
                      {rule.rulesOff > 0 && (
                        <div className="text-[10px] text-slate-500 dark:text-slate-400">{t('agentList.rulesOff', { count: rule.rulesOff })}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 font-normal text-slate-600 dark:text-slate-400">
                      {rule.sensors.join(', ')}
                    </td>
                    <td className="py-3 px-4 font-normal text-[11px] text-slate-500 dark:text-slate-400 space-y-1">
                      {rule.conditions.map((c, i) => <div key={i}>{c}</div>)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {rule.status === 'Deployed' && (
                        <button
                          type="button"
                          disabled={retiring === rule.workflow.id}
                          onClick={(e) => { e.stopPropagation(); retire(rule.workflow); }}
                          className="text-[11px] font-semibold text-rose-600 dark:text-rose-400 hover:underline disabled:opacity-40 cursor-pointer"
                        >
                          {t('agentList.retire')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400 font-sans">
                    {workflows === null && !error ? t('agentList.loading') : t('agentList.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination — matches Device Management's footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400 font-sans">
          <div>
            {t('agentList.totalRows')} <span className="font-semibold text-slate-800 dark:text-slate-200">{totalRows}</span>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span>{t('agentList.rowsPerPage')}</span>
              <SelectPicker
                data={[
                  { label: '10', value: 10 },
                  { label: '20', value: 20 },
                  { label: '50', value: 50 },
                ]}
                value={rowsPerPage}
                onChange={(value) => {
                  setRowsPerPage(Number(value ?? 10));
                  setCurrentPage(1);
                }}
                searchable={false}
                cleanable={false}
                size="sm"
                className="w-20"
              />
            </div>

            <div className="flex items-center gap-1">
              <button
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                aria-label={t('agentList.previousPage')}
                className="p-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              {Array.from({ length: totalPages }).map((_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentPage(i + 1)}
                  className={`w-7 h-7 rounded text-xs font-semibold flex items-center justify-center transition-colors ${
                    currentPage === i + 1
                      ? 'bg-[#0B7285] text-white border border-[#0B7285]'
                      : 'border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  {i + 1}
                </button>
              ))}

              <button
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                aria-label={t('agentList.nextPage')}
                className="p-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
