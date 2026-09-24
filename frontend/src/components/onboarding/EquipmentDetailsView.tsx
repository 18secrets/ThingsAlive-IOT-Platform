import React from 'react';
import { Calendar, Settings } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';

type LiveParamType = 'gauge' | 'value' | 'status';

interface LiveParam {
  key: string;
  label: string;
  value: number | string;
  unit: string;
  type: LiveParamType;
  max?: number;
  color?: string;
  /** Only the params with their own health signal (temperature/pressure) show one — matches the reference design's `statusKeys`. */
  showStatusDot?: boolean;
}

type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

interface AlertInsightItem {
  id: string;
  parameter: string;
  severity: AlertSeverity;
  actualValue: number;
  thresholdValue: number;
  occurredAt: string;
}

interface EquipmentDetail {
  equipment: string;
  projectCode: string;
  description: string;
  benchmarkLitresPerHour: number;
  manufacturer: string;
  deviceStatus: 'Online' | 'Offline' | 'Not Onboarded';
  assetVerified: 'Yes' | 'No';
  engineWorkingHours: number;
  engineWorkingHm: string;
  machineBreakdownHours: number;
  machineBreakdownHm: string;
  idleHours: number;
  idleHm: string;
  fuelConsumptionLitres: number;
  avgFuelConsumptionLitresPerHour: number;
  pmOrders: number;
  mttrHours: number;
  mtbfHours: number;
  location: { lat: number; lng: number; label: string };
  liveParams: LiveParam[];
  alerts: AlertInsightItem[];
}

// Mock — this screen has no backend yet (no per-asset telemetry API exists in this
// project), so this is a fixed demo reading rather than a live one. The shape
// mirrors a real device's log payload (device status, running hours, live gauges)
// so swapping in a real feed later is a data-source change, not a redesign.
const SAMPLE_EQUIPMENT: EquipmentDetail = {
  equipment: '4700137',
  projectCode: '0556',
  description: 'EXCAVATOR EX1200 W LONG BOOM REACH KIT',
  benchmarkLitresPerHour: 80,
  manufacturer: 'TATA HITACHI',
  deviceStatus: 'Online',
  assetVerified: 'Yes',
  engineWorkingHours: 2.05,
  engineWorkingHm: '2h 3m',
  machineBreakdownHours: 0,
  machineBreakdownHm: '0h 0m',
  idleHours: 0.01,
  idleHm: '0h 0m',
  fuelConsumptionLitres: 187.98,
  avgFuelConsumptionLitresPerHour: 91.7,
  pmOrders: 35,
  mttrHours: 0,
  mtbfHours: 94.55,
  location: { lat: 17.8615, lng: 83.2809, label: 'Rambilli' },
  liveParams: [
    { key: 'fuel_level', label: 'Fuel Level', value: 0, unit: 'ltr', type: 'value' },
    {
      key: 'engine_coolant_temperature', label: 'Engine Coolant Temperature', value: 82, unit: '°C',
      type: 'gauge', max: 150, color: '#61a075', showStatusDot: true,
    },
    {
      key: 'engine_oil_pressure', label: 'Engine Oil Pressure', value: 420, unit: 'KPA',
      type: 'gauge', max: 1035, color: '#61a075', showStatusDot: true,
    },
    {
      key: 'engine_oil_temperature', label: 'Engine Oil Temperature', value: 87, unit: '°C',
      type: 'gauge', max: 150, color: '#61a075', showStatusDot: true,
    },
    { key: 'throttle_position', label: 'Throttle Position', value: 100, unit: '%', type: 'value' },
    { key: 'engine_load', label: 'Engine Load', value: 7.3, unit: '%', type: 'gauge', max: 100, color: '#61a075' },
    { key: 'engine_running_status', label: 'Engine Running Status', value: 'ON', unit: '', type: 'status' },
    { key: 'device_engine_runtime', label: 'Device Engine Runtime', value: 654.2, unit: 'Hours', type: 'value' },
  ],
  alerts: [],
};

interface EquipmentDetailsViewProps {
  equipment?: EquipmentDetail;
}

const DEVICE_STATUS_STYLE: Record<EquipmentDetail['deviceStatus'], string> = {
  Online: 'bg-emerald-500 text-white',
  Offline: 'bg-rose-500 text-white',
  'Not Onboarded': 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
};

const InfoItem: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div>
    <div className="text-slate-500 dark:text-slate-400 text-xs font-medium">{label} :</div>
    <div className="font-semibold text-slate-800 dark:text-slate-100 mt-1 text-sm leading-snug">{value}</div>
  </div>
);

/** Semi-circular dial via a half-donut pie (0-180°) — same technique as the reference design. */
const Gauge: React.FC<{ value: number; max: number; color: string }> = ({ value, max, color }) => {
  const clamped = Math.min(Math.max(value, 0), max);
  const data = [
    { name: 'value', fill: color },
    { name: 'rest', fill: '#e5e7eb' },
  ];
  const chartData = [{ value: clamped }, { value: max - clamped }];

  return (
    <div className="relative w-full h-[70px] flex items-end justify-center">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={chartData}
            cx="50%"
            cy="100%"
            innerRadius="60%"
            outerRadius="100%"
            startAngle={180}
            endAngle={0}
            paddingAngle={0}
            dataKey="value"
            stroke="none"
            isAnimationActive={false}
          >
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.fill} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute bottom-0 left-0 w-full text-center pb-0.5">
        <span className="text-base font-bold text-[#03045e] dark:text-sky-300">{value}</span>
      </div>
    </div>
  );
};

const SEVERITY_CARD_STYLE: Record<AlertSeverity, string> = {
  critical: 'border-l-rose-500 bg-rose-50/60 dark:bg-rose-950/20',
  high: 'border-l-rose-500 bg-rose-50/60 dark:bg-rose-950/20',
  medium: 'border-l-amber-500 bg-amber-50/60 dark:bg-amber-950/20',
  low: 'border-l-sky-500 bg-sky-50/60 dark:bg-sky-950/20',
};
const SEVERITY_BADGE_STYLE: Record<AlertSeverity, string> = {
  critical: 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300',
  high: 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300',
  medium: 'bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300',
  low: 'bg-sky-100 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300',
};

const AlertCard: React.FC<{ alert: AlertInsightItem }> = ({ alert }) => (
  <div className={`rounded-lg border border-slate-100 dark:border-slate-800 border-l-4 p-3 ${SEVERITY_CARD_STYLE[alert.severity]}`}>
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-bold text-slate-700 dark:text-slate-200">{alert.parameter}</span>
      <span className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${SEVERITY_BADGE_STYLE[alert.severity]}`}>
        {alert.severity}
      </span>
    </div>
    <div className="flex justify-between text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">
      <span>Value:</span>
      <span className="font-semibold text-slate-700 dark:text-slate-200">{alert.actualValue}</span>
    </div>
    <div className="flex justify-between text-[11px] text-slate-500 dark:text-slate-400">
      <span>Threshold:</span>
      <span className="font-semibold text-slate-700 dark:text-slate-200">{alert.thresholdValue}</span>
    </div>
    <div className="text-[10px] text-slate-400 dark:text-slate-500 text-right mt-1 italic">{alert.occurredAt}</div>
  </div>
);

export const EquipmentDetailsView: React.FC<EquipmentDetailsViewProps> = ({ equipment = SAMPLE_EQUIPMENT }) => {
  const eq = equipment;

  return (
    <div id="equipment-details-view" className="space-y-4">
      {/* Page-local toolbar — title & back navigation already live in the shared
         header above; this row carries the two controls that are specific to
         this screen. */}
      <div className="flex justify-end items-center gap-2">
        <button
          type="button"
          className="flex items-center gap-2 px-3.5 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
        >
          <Calendar className="w-3.5 h-3.5" />
          Select Date Range
        </button>
      </div>

      {/* Info grid + location */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-5 flex flex-col lg:flex-row gap-6">
        <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-6 gap-y-5">
          <InfoItem label="Equipment" value={eq.equipment} />
          <InfoItem label="Project Code" value={eq.projectCode} />
          <InfoItem label="Description" value={eq.description} />
          <InfoItem label="Benchmark" value={`${eq.benchmarkLitresPerHour} Litres/Hour`} />
          <InfoItem label="Manufacturer" value={eq.manufacturer} />

          <InfoItem
            label="Device Status"
            value={
              <span className={`inline-block px-2.5 py-1 rounded-md text-xs font-semibold ${DEVICE_STATUS_STYLE[eq.deviceStatus]}`}>
                {eq.deviceStatus}
              </span>
            }
          />
          <InfoItem label="Asset Verified" value={eq.assetVerified} />
          <InfoItem label="Engine Working Hours" value={`${eq.engineWorkingHours.toFixed(2)} (${eq.engineWorkingHm})`} />
          <InfoItem label="Machine Breakdown Hours" value={`${eq.machineBreakdownHours.toFixed(2)} (${eq.machineBreakdownHm})`} />
          <InfoItem label="Idle Hours" value={`${eq.idleHours.toFixed(2)} (${eq.idleHm})`} />

          <InfoItem label="Fuel Consumption" value={`${eq.fuelConsumptionLitres} Litres`} />
          <InfoItem label="Avg Fuel Consumption" value={`${eq.avgFuelConsumptionLitresPerHour} Litres/Hour`} />
          <InfoItem label="PM Orders" value={eq.pmOrders} />
          <InfoItem label="MTTR" value={`${eq.mttrHours.toFixed(2)} Hours`} />
          <InfoItem label="MTBF" value={`${eq.mtbfHours.toFixed(2)} Hours`} />
        </div>

        <div className="w-full lg:w-72 h-56 lg:h-auto shrink-0 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
          <iframe
            title="Equipment location"
            className="w-full h-full border-0"
            loading="lazy"
            src={`https://maps.google.com/maps?q=${eq.location.lat},${eq.location.lng}&z=12&output=embed`}
          />
        </div>
      </div>

      {/* Live Parameters + Alert Insight */}
      <div className="flex flex-col lg:flex-row gap-4">
        <div className="flex-1 bg-slate-50 dark:bg-slate-800/40 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">Live Parameters</h3>
            <span className="text-xs text-slate-400 dark:text-slate-500">Information Report | Trends</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {eq.liveParams.map((p) => (
              <div
                key={p.key}
                className="bg-white dark:bg-slate-900 rounded-lg shadow-xs p-3 flex flex-col items-center justify-between gap-1"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 text-center">
                    {p.label}
                  </span>
                  {p.showStatusDot && <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />}
                </div>

                {p.type === 'gauge' && <Gauge value={p.value as number} max={p.max ?? 100} color={p.color ?? '#61a075'} />}
                {p.type === 'value' && (
                  <div className="h-[70px] flex items-center">
                    <span className="text-2xl font-extrabold text-[#03045e] dark:text-sky-300">{p.value}</span>
                  </div>
                )}
                {p.type === 'status' && (
                  <div className="h-[70px] flex items-center">
                    <span
                      className={`px-3 py-1.5 rounded-md text-xl font-extrabold ${
                        p.value === 'ON'
                          ? 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300'
                          : 'bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300'
                      }`}
                    >
                      {p.value}
                    </span>
                  </div>
                )}

                <div className="text-[11px] text-slate-400 dark:text-slate-500 font-medium">{p.unit}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="w-full lg:w-80 shrink-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-4">
          <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 mb-3">Alert Insight</h3>
          {eq.alerts.length === 0 ? (
            <div className="text-center text-sm text-slate-400 dark:text-slate-500 py-10">No active alerts</div>
          ) : (
            <div className="space-y-3 max-h-[520px] overflow-y-auto pr-1">
              {eq.alerts.map((a) => <AlertCard key={a.id} alert={a} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
