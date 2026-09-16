import React, { useMemo } from 'react';
import {
  Activity,
  AlertTriangle,
  Radio,
  Wrench,
  CheckCircle2,
} from 'lucide-react';
import { EquipmentItem, DeviceItem } from '../../types';
import { DeviceConnectivityChart, EquipmentStatusChart } from '../dashboard/AnalyticsCharts';

interface DashboardViewProps {
  equipment: EquipmentItem[];
  devices: DeviceItem[];
  onNavigateToDevices: () => void;
  onNavigateToEquipment: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  equipment,
  devices,
  onNavigateToDevices,
  onNavigateToEquipment,
}) => {
  const onlineDevices = devices.filter((d) => d.status === 'Online');
  const offlineDevices = devices.filter((d) => d.status !== 'Online');
  const healthIndex = devices.length ? Math.round((onlineDevices.length / devices.length) * 100) : 100;
  const plantCount = useMemo(
    () => new Set(equipment.map((e) => e.maintPlant).filter(Boolean)).size,
    [equipment]
  );
  // Most recently-pinged devices first, so the feed reads like a live stream.
  const recentDevices = useMemo(() => devices.slice(0, 6), [devices]);

  const connectivityByPlant = useMemo(() => {
    const plantNames = Array.from(new Set(devices.map((d) => d.plant).filter((p): p is string => !!p)));
    return plantNames.map((plant) => ({
      label: plant,
      online: devices.filter((d) => d.plant === plant && d.status === 'Online').length,
      offline: devices.filter((d) => d.plant === plant && d.status !== 'Online').length,
    }));
  }, [devices]);

  const equipmentStatusCounts = useMemo(
    () => ({
      active: equipment.filter((e) => e.status === 'Active').length,
      underMaintenance: equipment.filter((e) => e.status === 'Under Maintenance').length,
      idle: equipment.filter((e) => e.status === 'Idle').length,
    }),
    [equipment]
  );

  return (
    <div id="client-dashboard-view" className="space-y-6">
      {/* KPI Cards — matches the Master Admin dashboard's card style */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Fleet Health Index</div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{healthIndex}%</div>
            <div className="text-[11px] text-slate-400 mt-1">{onlineDevices.length} of {devices.length} devices online</div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
            <Activity className="w-5 h-5" />
          </div>
        </div>

        <button
          type="button"
          onClick={onNavigateToEquipment}
          className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between text-left hover:border-sky-300 dark:hover:border-sky-700 transition-colors cursor-pointer"
        >
          <div>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Active Equipment</div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{equipment.length}</div>
            <div className="text-[11px] text-slate-400 mt-1">Across {plantCount || 1} plant{plantCount === 1 ? '' : 's'}</div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
            <Wrench className="w-5 h-5" />
          </div>
        </button>

        <button
          type="button"
          onClick={onNavigateToDevices}
          className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between text-left hover:border-sky-300 dark:hover:border-sky-700 transition-colors cursor-pointer"
        >
          <div>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Online Telematics</div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{onlineDevices.length} / {devices.length}</div>
            <div className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1">Real-time CAN/MODBUS streaming</div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <Radio className="w-5 h-5" />
          </div>
        </button>

        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Active Diagnostics</div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{offlineDevices.length}</div>
            <div className={`text-[11px] mt-1 ${offlineDevices.length ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400'}`}>
              {offlineDevices.length
                ? `${offlineDevices[0].name} — heartbeat missing`
                : 'All systems nominal'}
            </div>
          </div>
          <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
            offlineDevices.length
              ? 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400'
              : 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400'
          }`}>
            {offlineDevices.length ? <AlertTriangle className="w-5 h-5" /> : <CheckCircle2 className="w-5 h-5" />}
          </div>
        </div>
      </div>

      {/* Live Telemetry + System Health */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">Industrial Telemetry Streams</h3>
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase rounded border px-2 py-0.5 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live Gateway Feed
            </span>
          </div>

          <div className="p-4 space-y-2.5">
            {recentDevices.length > 0 ? (
              recentDevices.map((device) => (
                <div
                  key={device.id}
                  className="flex items-center gap-3 p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-sky-300 dark:hover:border-sky-700 transition-colors"
                >
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                      device.status === 'Online'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    <Radio className="w-4 h-4" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">
                        {device.equipmentName || device.name}
                      </span>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border shrink-0 ${
                          device.status === 'Online'
                            ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                            : 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800'
                        }`}
                      >
                        {device.status}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 truncate">
                      {device.plant || 'Unassigned plant'} • {device.toolProfile || device.category || 'Telematics unit'}
                    </div>
                  </div>

                  <div className="text-[11px] text-slate-400 font-mono shrink-0">
                    {device.lastPing || '—'}
                  </div>
                </div>
              ))
            ) : (
              <div className="py-8 text-center text-slate-400 text-sm">No devices reporting telemetry yet.</div>
            )}
          </div>
        </div>

        {/* System Health & Telematics OS */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
            <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">System Health & Telematics OS</h3>
          </div>
          <div className="p-4 space-y-3 text-xs">
            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Operating System</span>
              <div className="font-semibold text-slate-800 dark:text-slate-100 text-sm mt-0.5">ThingsAlive Telematics v1.0.5</div>
            </div>
            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">MODBUS / CAN Ingestion</span>
              <div className="font-semibold text-emerald-600 dark:text-emerald-400 text-sm mt-0.5">Synchronized (502 / 2939)</div>
            </div>
            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Cloud Database</span>
              <div className="font-semibold text-slate-800 dark:text-slate-100 text-sm mt-0.5">Fleet State Active</div>
            </div>
          </div>
        </div>
      </div>

      {/* Analytics */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <DeviceConnectivityChart
          title="Device Connectivity by Plant"
          subtitle="Online vs. offline devices across your sites"
          groups={connectivityByPlant}
        />
        <EquipmentStatusChart
          title="Equipment Status"
          subtitle="Your fleet, by operating status"
          active={equipmentStatusCounts.active}
          underMaintenance={equipmentStatusCounts.underMaintenance}
          idle={equipmentStatusCounts.idle}
        />
      </div>
    </div>
  );
};


