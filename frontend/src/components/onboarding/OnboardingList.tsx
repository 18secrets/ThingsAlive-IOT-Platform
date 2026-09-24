import React, { useState, useMemo } from 'react';
import {
  Search,
  Plus,
  Sparkles,
  CheckCircle2,
  Clock,
  Building2,
  Wrench,
  QrCode,
  ListChecks,
  Pencil,
  RotateCw,
  X,
  Printer
} from 'lucide-react';
import { OnboardingSessionItem } from '../../types';

interface OnboardingListProps {
  sessions: OnboardingSessionItem[];
  onAddNew: () => void;
  onViewSession?: (id: string) => void;
  onEditSession?: (id: string) => void;
  onToggleActive?: (id: string) => void;
  onRefreshSession?: (id: string) => void;
}

// Deterministic "QR-looking" pixel grid derived from the session id — a lightweight
// stand-in for a real QR encoder, just for the print-label preview.
const qrCells = (seed: string, size = 9): boolean[] => {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const cells: boolean[] = [];
  for (let i = 0; i < size * size; i++) {
    hash = (hash * 1103515245 + 12345) >>> 0;
    cells.push((hash >> 16) % 3 !== 0);
  }
  return cells;
};

const QrThumb: React.FC<{ seed: string; size?: number; className?: string }> = ({ seed, size = 9, className }) => {
  const cells = useMemo(() => qrCells(seed, size), [seed, size]);
  return (
    <div
      className={`grid bg-white dark:bg-white p-1 rounded ${className || ''}`}
      style={{ gridTemplateColumns: `repeat(${size}, 1fr)`, width: 'fit-content' }}
    >
      {cells.map((filled, i) => (
        <span
          key={i}
          className={filled ? 'bg-slate-900' : 'bg-transparent'}
          style={{ width: 3, height: 3 }}
        />
      ))}
    </div>
  );
};

export const OnboardingList: React.FC<OnboardingListProps> = ({
  sessions,
  onAddNew,
  onViewSession,
  onEditSession,
  onToggleActive,
  onRefreshSession,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('All');
  const [qrSession, setQrSession] = useState<OnboardingSessionItem | null>(null);
  const [reloadingId, setReloadingId] = useState<string | null>(null);

  const filteredSessions = useMemo(() => {
    return sessions.filter((s) => {
      const matchSearch = s.name.toLowerCase().includes(searchTerm.toLowerCase());
      const matchStatus = selectedStatus === 'All' || s.status === selectedStatus;
      return matchSearch && matchStatus;
    });
  }, [sessions, searchTerm, selectedStatus]);

  const completedCount = sessions.filter((s) => s.status === 'Completed').length;
  const inProgressCount = sessions.filter((s) => s.status === 'In Progress').length;

  const handleReload = (id: string) => {
    setReloadingId(id);
    onRefreshSession?.(id);
    setTimeout(() => setReloadingId((current) => (current === id ? null : current)), 600);
  };

  return (
    <div id="onboarding-list-view" className="space-y-6">

      {/* Metric Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              Total Sessions
            </div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">
              {sessions.length}
            </div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center">
            <Sparkles className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              Completed
            </div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">
              {completedCount}
            </div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              In Progress
            </div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">
              {inProgressCount}
            </div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center">
            <Clock className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Search / Filter / Add Bar */}
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search Onboarding Sessions..."
              className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
            />
          </div>

          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="py-2 px-3 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:border-sky-500 cursor-pointer"
          >
            <option value="All">Select Status (All)</option>
            <option value="Completed">Completed</option>
            <option value="In Progress">In Progress</option>
          </select>
        </div>

        <button
          id="add-onboarding-btn"
          onClick={onAddNew}
          className="w-full sm:w-auto px-5 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>New AI Onboarding</span>
        </button>
      </div>

      {/* Sessions Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-4">Session</th>
                <th className="py-3 px-4">Sites</th>
                <th className="py-3 px-4">Equipment</th>
                <th className="py-3 px-4">Progress</th>
                <th className="py-3 px-4">Created</th>
                <th className="py-3 px-4">Updated</th>
                <th className="py-3 px-4 text-center">Print</th>
                <th className="py-3 px-4 text-center">View</th>
                <th className="py-3 px-4 text-center">Status</th>
                <th className="py-3 px-4 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {filteredSessions.length > 0 ? (
                filteredSessions.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
                        <Sparkles className="w-3.5 h-3.5" />
                      </div>
                      <span>{s.name}</span>
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">
                      <span className="flex items-center gap-1.5">
                        <Building2 className="w-3.5 h-3.5 text-slate-400" />
                        {s.sitesCount}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">
                      <span className="flex items-center gap-1.5">
                        <Wrench className="w-3.5 h-3.5 text-slate-400" />
                        {s.equipmentCount}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${
                          s.status === 'Completed'
                            ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                            : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800'
                        }`}
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                      {s.createdAt}
                    </td>
                    <td className="py-3 px-4 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                      {s.updatedAt}
                    </td>

                    {/* Print QR */}
                    <td className="py-3 px-4">
                      <button
                        onClick={() => setQrSession(s)}
                        className="mx-auto flex items-center justify-center hover:opacity-75 transition-opacity cursor-pointer"
                        title="Print QR Label"
                      >
                        <QrThumb seed={s.id} />
                      </button>
                    </td>

                    {/* View */}
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={() => (onViewSession ? onViewSession(s.id) : onAddNew())}
                        className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sky-600 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/40 hover:border-sky-300 transition-colors cursor-pointer"
                        title="View Session"
                      >
                        <ListChecks className="w-4 h-4" />
                      </button>
                    </td>

                    {/* Status toggle */}
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={() => onToggleActive?.(s.id)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
                          s.active ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'
                        }`}
                        title={s.active ? 'Active' : 'Inactive'}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            s.active ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </td>

                    {/* Actions: edit + reload */}
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => (onEditSession ? onEditSession(s.id) : onAddNew())}
                          className="p-1.5 text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 transition-colors cursor-pointer"
                          title="Edit Session"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleReload(s.id)}
                          className="p-1.5 text-sky-500 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 transition-colors cursor-pointer"
                          title="Refresh Status"
                        >
                          <RotateCw className={`w-4 h-4 ${reloadingId === s.id ? 'animate-spin' : ''}`} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={10} className="py-10 text-center text-slate-400 font-sans">
                    No onboarding sessions found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* QR Print Preview Modal */}
      {qrSession && (
        <div
          id="onboarding-qr-modal-overlay"
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
        >
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">
                Print QR Label
              </h3>
              <button
                onClick={() => setQrSession(null)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 flex flex-col items-center gap-4">
              <QrThumb seed={qrSession.id} size={17} className="p-3" />
              <div className="text-center">
                <div className="font-semibold text-sm text-slate-800 dark:text-slate-100">
                  {qrSession.name}
                </div>
                <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                  {qrSession.id.toUpperCase()}
                </div>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2.5">
              <button
                onClick={() => setQrSession(null)}
                className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                Close
              </button>
              <button
                onClick={() => window.print()}
                className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5" />
                <span>Print</span>
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
