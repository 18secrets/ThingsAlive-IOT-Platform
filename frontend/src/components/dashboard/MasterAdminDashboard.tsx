import React, { useState, useMemo } from 'react';
import {
  Building2,
  Cpu,
  Wrench,
  Sparkles,
  Filter,
  Layers,
  MapPin
} from 'lucide-react';
import { ClientAccount, DeviceItem, EquipmentItem, OnboardingSessionItem } from '../../types';
import { DeviceConnectivityChart, EquipmentStatusChart } from './AnalyticsCharts';

interface MasterAdminDashboardProps {
  clients: ClientAccount[];
  devices: DeviceItem[];
  equipmentList: EquipmentItem[];
  onboardingSessions: OnboardingSessionItem[];
}

type TimeRange = 'all' | 'week' | 'month';
type StatusFilter = 'All' | 'Completed' | 'In Progress';

const parseDate = (s: string) => new Date(s);

export const MasterAdminDashboard: React.FC<MasterAdminDashboardProps> = ({
  clients,
  devices,
  equipmentList,
  onboardingSessions,
}) => {
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');

  // Use the most recent activity in the dataset itself as "now" so the time
  // filters stay meaningful regardless of the real wall-clock date.
  const referenceDate = useMemo(() => {
    const times = onboardingSessions
      .map((s) => parseDate(s.updatedAt).getTime())
      .filter((t) => !isNaN(t));
    return times.length ? new Date(Math.max(...times)) : new Date();
  }, [onboardingSessions]);

  const filteredSessions = useMemo(() => {
    return onboardingSessions
      .filter((s) => statusFilter === 'All' || s.status === statusFilter)
      .filter((s) => {
        if (timeRange === 'all') return true;
        const d = parseDate(s.updatedAt);
        if (isNaN(d.getTime())) return true;
        const diffDays = (referenceDate.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
        return timeRange === 'week' ? diffDays <= 7 : diffDays <= 30;
      })
      .sort((a, b) => parseDate(b.updatedAt).getTime() - parseDate(a.updatedAt).getTime());
  }, [onboardingSessions, statusFilter, timeRange, referenceDate]);

  const equipmentMappedViaOnboarding = filteredSessions.reduce((acc, s) => acc + s.equipmentCount, 0);
  const activeClientsCount = clients.filter((c) => c.status === 'Active').length;

  const connectivityByClient = useMemo(() => {
    return clients
      .map((c) => ({
        label: c.clientName,
        online: devices.filter((d) => d.clientId === c.id && d.status === 'Online').length,
        offline: devices.filter((d) => d.clientId === c.id && d.status === 'Offline').length,
      }))
      .filter((g) => g.online + g.offline > 0);
  }, [clients, devices]);

  const equipmentStatusCounts = useMemo(
    () => ({
      active: equipmentList.filter((e) => e.status === 'Active').length,
      underMaintenance: equipmentList.filter((e) => e.status === 'Under Maintenance').length,
      idle: equipmentList.filter((e) => e.status === 'Idle').length,
    }),
    [equipmentList]
  );

  return (
    <div id="master-admin-dashboard-view" className="space-y-6">

      {/* Filters */}
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400 shrink-0">
          <Filter className="w-3.5 h-3.5" />
          <span>Onboarding Activity Filters</span>
        </div>
        <div className="flex items-center gap-3 flex-wrap sm:ml-auto">
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value as TimeRange)}
            className="py-2 px-3 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:border-sky-500 cursor-pointer"
          >
            <option value="all">All Time</option>
            <option value="week">Last 7 Days</option>
            <option value="month">Last 30 Days</option>
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="py-2 px-3 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:border-sky-500 cursor-pointer"
          >
            <option value="All">Select Status (All)</option>
            <option value="Completed">Completed</option>
            <option value="In Progress">In Progress</option>
          </select>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Total Clients</div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{clients.length}</div>
            <div className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1">{activeClientsCount} active</div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center">
            <Building2 className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Total Devices</div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{devices.length}</div>
            <div className="text-[11px] text-slate-400 mt-1">{devices.filter(d => d.status === 'Online').length} online</div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
            <Cpu className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Total Equipment</div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{equipmentList.length}</div>
            <div className="text-[11px] text-slate-400 mt-1">{equipmentList.filter(e => e.onboardStatus === 'Onboarded').length} onboarded</div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center">
            <Wrench className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Onboarding Sessions</div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{filteredSessions.length}</div>
            <div className="text-[11px] text-violet-600 dark:text-violet-400 mt-1">{equipmentMappedViaOnboarding} equipment mapped</div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-violet-50 dark:bg-violet-950/60 text-violet-600 dark:text-violet-400 flex items-center justify-center">
            <Sparkles className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Analytics */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <DeviceConnectivityChart
          title="Device Connectivity by Client"
          subtitle="Online vs. offline devices across every tenant"
          groups={connectivityByClient}
        />
        <EquipmentStatusChart
          title="Equipment Status Across Fleet"
          subtitle="Every client's equipment, by operating status"
          active={equipmentStatusCounts.active}
          underMaintenance={equipmentStatusCounts.underMaintenance}
          idle={equipmentStatusCounts.idle}
        />
      </div>

      {/* Recent Onboarding Activity (chat sessions) */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">Recent Onboarding Activity</h3>
          <span className="text-[11px] text-slate-400">Chat-guided setup sessions across all clients</span>
        </div>

        <div className="p-4 space-y-2.5">
          {filteredSessions.length > 0 ? (
            filteredSessions.map((session) => (
              <div
                key={session.id}
                className="flex items-center gap-3 p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-sky-300 dark:hover:border-sky-700 transition-colors"
              >
                <div className="w-9 h-9 rounded-full bg-sky-600 text-white flex items-center justify-center shrink-0">
                  <Sparkles className="w-4 h-4" />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">
                      {session.name}
                    </span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border shrink-0 ${
                        session.status === 'Completed'
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                          : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800'
                      }`}
                    >
                      {session.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{session.sitesCount} Sites</span>
                    <span className="flex items-center gap-1"><Layers className="w-3 h-3" />{session.equipmentCount} Equipment</span>
                  </div>
                </div>

                <div className="text-[11px] text-slate-400 font-mono shrink-0">
                  {session.updatedAt}
                </div>
              </div>
            ))
          ) : (
            <div className="py-8 text-center text-slate-400 text-sm">
              No onboarding activity matches these filters.
            </div>
          )}
        </div>
      </div>

    </div>
  );
};
