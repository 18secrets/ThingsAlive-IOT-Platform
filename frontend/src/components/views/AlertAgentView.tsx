import React, { useEffect, useState, useMemo } from 'react';
import { Search, Sparkles, Cpu } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { ApiError, Workflow, WorkflowVersion, apiListWorkflows, apiRetireWorkflow } from '../../lib/api';
import { WorkflowDraft } from '../../utils/workflowParser';
import { specSignals } from '../alerts/workflow/workflowGraph';
import { useNavigate } from 'react-router-dom';
import { ListTable } from '../common/ListTable';
import { RecordCards } from '../common/RecordCards';
import { LIST_PANEL, TablePagination, usePagination } from '../common/TablePagination';
import { ViewModeToggle, useViewMode } from '../common/ViewModeToggle';
import { sortRows, useSort } from '../../lib/useSort';
import { appLocale, appTimeZone } from '../../lib/dateLocale';
import { useWorkflowScope } from '../alerts/workflow/useWorkflowScope';

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
  /** Where the list starts: the assistant's "Explore more" opens it on its drafts (TC_198). */
  initialStatus?: string;
  initialSearch?: string;
}

export const AlertAgentView: React.FC<AlertAgentViewProps> = ({ onAddAlert, onOpen, initialStatus = 'All', initialSearch = '' }) => {
  const { t } = useTranslation('alerts');
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState(initialSearch);
  const [selectedStatus, setSelectedStatus] = useState(initialStatus);
  const [viewMode, setViewMode] = useViewMode('alert-agent');
  const scopeData = useWorkflowScope();
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

  // Newest first (17 Nov): sorted by its ID, the draft just saved landed at the bottom.
  const { sort, toggle } = useSort<'name' | 'status' | 'edited'>({ key: 'edited', dir: 'desc' });
  const sorted = useMemo(() => sortRows(filteredRules, sort, {
    name: (r) => r.workflow.name.toLowerCase(),
    status: (r) => r.status,
    edited: (r) => r.workflow.updatedAt,
  }), [filteredRules, sort]);
  const { pageItems, ...pager } = usePagination(sorted);

  // What it watches, in words: the machine's name, not its scope's ids.
  const appliesTo = (rule: AlertRuleRow) => {
    const target = rule.open.spec.scope;
    if (target.appliesTo !== 'equipment') return t(`assistant.draftScope.${target.appliesTo}`);
    const m = scopeData.machines.find((x) => x.sourceSystem === target.sourceSystem && x.externalId === target.externalId);
    return m ? scopeData.machineLabel(m) : target.externalId ?? '—';
  };
  const edited = (rule: AlertRuleRow) => new Date(rule.workflow.updatedAt)
    .toLocaleString(appLocale(), { timeZone: appTimeZone(), dateStyle: 'medium', timeStyle: 'short' });
  const open = (rule: AlertRuleRow) => onOpen({
    name: rule.workflow.name, spec: rule.open.spec, workflowId: rule.workflow.id,
    version: rule.open.version, status: rule.open.status, layout: rule.open.layout,
  });

  // The name leads, its description under it; the internal id (a slug) is no column of its
  // own any more: centred and wrapped over three lines, it said nothing a reader uses.
  const hasActions = pageItems.some((r) => r.status === 'Deployed');
  const columns = [
    { label: t('agentList.columns.workflowName'), sortKey: 'name', grow: 3, minWidth: 220 },
    { label: t('agentList.columns.appliesTo'), grow: 2, minWidth: 170 },
    { label: t('agentList.columns.status'), sortKey: 'status', width: 150 },
    { label: t('agentList.columns.conditions'), grow: 3, minWidth: 240 },
    { label: t('agentList.columns.lastEdited'), sortKey: 'edited', width: 170 },
    // Retire is the only action besides opening, which the row itself does; it applies to
    // a deployed workflow only, so the column is there only when one is on the page.
    ...(hasActions ? [{ label: t('agentList.columns.actions'), width: 110, align: 'right' as const }] : []),
  ];
  const cells = (rule: AlertRuleRow): React.ReactNode[] => [
    <div className="min-w-0">
      <div className="font-semibold text-slate-900 dark:text-white break-words">{rule.workflow.name}</div>
      {rule.workflow.description && <div className="text-xs text-slate-500 dark:text-slate-400 break-words line-clamp-2">{rule.workflow.description}</div>}
    </div>,
    // Wraps rather than cut: "POC-MINI-01 · POC M…" hid which pump it was.
    <span className="flex items-start gap-1.5 min-w-0 text-slate-700 dark:text-slate-200">
      <Cpu className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" /><span className="break-words min-w-0">{appliesTo(rule)}</span>
    </span>,
    <div className="space-y-1">
      <span className={`inline-flex items-center px-2 py-0.5 text-[0.6875rem] font-semibold uppercase rounded border ${STATUS_STYLES[rule.status]}`}>
        <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${STATUS_DOT[rule.status]}`}></span>
        {t(`agentList.status.${rule.status}`, { defaultValue: rule.status })}
      </span>
      {rule.pendingDraft != null && <div className="text-[0.6875rem] text-amber-600 dark:text-amber-400">{t('agentList.pendingDraft', { version: rule.pendingDraft })}</div>}
      {rule.rulesOff > 0 && <div className="text-[0.6875rem] text-slate-500 dark:text-slate-400">{t('agentList.rulesOff', { count: rule.rulesOff })}</div>}
    </div>,
    <div className="space-y-1 text-xs text-slate-600 dark:text-slate-300">
      {rule.conditions.length ? rule.conditions.map((c, i) => <div key={i} className="break-words">{c}</div>) : <span className="text-slate-400">{rule.sensors.join(', ') || '—'}</span>}
    </div>,
    <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">{edited(rule)}</span>,
    ...(hasActions ? [<div className="flex items-center justify-end gap-2 [&>*]:whitespace-nowrap">
      {rule.status === 'Deployed' && (
        <button type="button" disabled={retiring === rule.workflow.id} onClick={(e) => { e.stopPropagation(); retire(rule.workflow); }}
          className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 text-rose-600 dark:text-rose-400 hover:border-rose-300 disabled:opacity-40 cursor-pointer">
          {t('agentList.retire')}
        </button>
      )}
    </div>] : []),
  ];

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
            }}
            searchable={false}
            cleanable={false}
            size="sm"
          />
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        <button
          type="button"
          onClick={() => navigate('/drafts?kind=workflow')}
          className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
        >
          {t('agentList.drafts')}
        </button>
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
      </div>

      {error && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">{error}</div>
      )}

      <div className={LIST_PANEL}>
        {pageItems.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-400">{workflows === null && !error ? t('agentList.loading') : t('agentList.empty')}</p>
        ) : viewMode === 'list' ? (
          <ListTable bare columns={columns} rows={pageItems} rowKey={(r) => r.workflow.id} cells={cells} onOpen={open}
            sort={sort} onSort={(key) => toggle(key as 'name' | 'status' | 'edited', key === 'edited' ? 'desc' : 'asc')} />
        ) : (
          <div className="p-4">
            <RecordCards columns={columns} rows={pageItems} rowKey={(r) => r.workflow.id} cells={cells} onOpen={open} actionsIndex={hasActions ? 5 : undefined} />
          </div>
        )}
        {pageItems.length > 0 && <TablePagination pinToBottom {...pager} />}
      </div>
    </div>
  );
};
