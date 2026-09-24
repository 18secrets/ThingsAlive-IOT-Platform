import React, { useState, useMemo } from 'react';
import { Search, Sparkles, ChevronLeft, ChevronRight, HelpCircle } from 'lucide-react';

interface AlertRuleRow {
  id: number;
  workflowName: string;
  description: string;
  status: 'Deployed' | 'Draft' | 'Disabled';
  sensors: string[];
  conditions: string;
}

// Mirrors the workflow-builder-generated alert rules a client sees today —
// a mix of auto-named drafts and one manually named rule, same as production.
const ALERT_RULES: AlertRuleRow[] = [
  {
    id: 3177,
    workflowName: 'Generated_Alarm_Rule',
    description: 'Generated from form',
    status: 'Deployed',
    sensors: ['Temperature'],
    conditions: 'Temperature (°c) > 70',
  },
  {
    id: 3176,
    workflowName: 'Workflow_draft-1788869506444-6ufkjcozn',
    description: 'Raise a critical alarm if the temperature is above 75C for 10 minutes and Converter Oil Temperature increases 60 deg in the last 1 hour.',
    status: 'Deployed',
    sensors: ['Temperature', 'Converter_oil_temperature'],
    conditions: 'Temperature > 75; Converter_oil_temperature >= 60',
  },
  {
    id: 3144,
    workflowName: 'Workflow_draft-1787654827228-mb2f7qodw',
    description: 'Raise a critical alarm per day one if the average Transmission Oil Pressure Kpa is more than 1500',
    status: 'Deployed',
    sensors: ['Transmission_oil_pressure_kpa'],
    conditions: 'Transmission_oil_pressure_kpa > 1500',
  },
  {
    id: 3137,
    workflowName: 'Workflow_draft-1787635322087-63y4dzwh',
    description: 'Raise a critical alarm if the average Engine Oil Temp DegC is less than 120 and Engine Rpm is more than 800; this should be generated every 12 hours once',
    status: 'Deployed',
    sensors: ['Engine Oil Temp DegC', 'Engine Rpm'],
    conditions: 'Engine oil temp degc < 120; Engine rpm > 800',
  },
  {
    id: 3125,
    workflowName: 'Workflow_draft-1787528114409-fh82klqm',
    description: 'Raise a critical alarm if the average Fuel Level drops by more than 20L in under 2 minutes',
    status: 'Deployed',
    sensors: ['Fuel_Level_Sensor'],
    conditions: 'Fuel_Level_Sensor delta < -20 over 2 min',
  },
  {
    id: 3118,
    workflowName: 'Workflow_draft-1787421903221-9zxpqwe1',
    description: 'Raise a high alarm if the Hydraulic Oil Temperature stays above 92C for 15 minutes',
    status: 'Deployed',
    sensors: ['Hydraulic_Temperature_Sensor'],
    conditions: 'Hydraulic_Temperature_Sensor > 92 for 15 min',
  },
  {
    id: 3102,
    workflowName: 'Workflow_draft-1787310556781-2mv5jact',
    description: 'Raise a critical alarm if DPF Pressure exceeds 2.8 kPa for 5 minutes',
    status: 'Deployed',
    sensors: ['DPF_Pressure_Sensor'],
    conditions: 'DPF_Pressure_Sensor > 2.8',
  },
  {
    id: 3094,
    workflowName: 'Workflow_draft-1787209887432-wq3ktz0v',
    description: 'Raise a medium alarm if Battery Voltage drops below 11.5V for more than 3 minutes',
    status: 'Deployed',
    sensors: ['Battery_Voltage_Sensor'],
    conditions: 'Battery_Voltage_Sensor < 11.5 for 3 min',
  },
  {
    id: 3081,
    workflowName: 'Workflow_draft-1787108332190-lk9fzr3c',
    description: 'Raise a critical alarm if Coolant Pressure and Engine Temperature both exceed threshold within the same 10 minute window',
    status: 'Draft',
    sensors: ['Coolant_Pressure_Sensor', 'Engine_Temperature_Sensor'],
    conditions: 'Coolant_Pressure_Sensor > 180; Engine_Temperature_Sensor > 105',
  },
  {
    id: 3073,
    workflowName: 'Workflow_draft-1787002210987-h7bvmye4',
    description: 'Raise a high alarm if NOx levels exceed limit for 3 consecutive readings',
    status: 'Deployed',
    sensors: ['NOx_Sensor'],
    conditions: 'NOx_Sensor > 400 ppm (x3 consecutive)',
  },
  {
    id: 3066,
    workflowName: 'Workflow_draft-1786907765511-a2ptkdxr',
    description: 'Raise a critical alarm if Boom Angle exceeds safe operating range for a crane in transit',
    status: 'Deployed',
    sensors: ['Boom_Angle_Sensor'],
    conditions: 'Boom_Angle_Sensor > 78°',
  },
  {
    id: 3052,
    workflowName: 'Workflow_draft-1786811098422-3wvyzuqn',
    description: 'Raise a medium alarm if DEF Level drops below 8% remaining',
    status: 'Deployed',
    sensors: ['DEF_Level_Sensor'],
    conditions: 'DEF_Level_Sensor < 8%',
  },
  {
    id: 3041,
    workflowName: 'Workflow_draft-1786702554398-qz1mfxts',
    description: 'Raise a critical alarm if Exhaust Temperature spikes more than 40°C within 60 seconds',
    status: 'Disabled',
    sensors: ['Exhaust_Temperature_Sensor'],
    conditions: 'Exhaust_Temperature_Sensor delta > 40 over 60s',
  },
  {
    id: 3037,
    workflowName: 'Workflow_draft-1786611287765-8dktvloc',
    description: 'Raise a high alarm if Knock Sensor detects abnormal frequency for more than 10 seconds',
    status: 'Deployed',
    sensors: ['Knock_Sensor'],
    conditions: 'Knock_Sensor freq > threshold for 10s',
  },
  {
    id: 3029,
    workflowName: 'Workflow_draft-1786498832140-yg6wnzrp',
    description: 'Raise a critical alarm if Air Filter Pressure differential exceeds 3.5 kPa',
    status: 'Deployed',
    sensors: ['Air_Filter_Pressure_Sensor'],
    conditions: 'Air_Filter_Pressure_Sensor > 3.5',
  },
  {
    id: 3014,
    workflowName: 'Workflow_draft-1786390276981-4jpsltmx',
    description: 'Raise a medium alarm if Transmission Temperature is above 115°C for more than 8 minutes',
    status: 'Deployed',
    sensors: ['Transmission_Temperature_Sensor'],
    conditions: 'Transmission_Temperature_Sensor > 115 for 8 min',
  },
  {
    id: 3003,
    workflowName: 'Workflow_draft-1786288119654-r0mzxycf',
    description: 'Raise a critical alarm if EGT exceeds 650°C at any point',
    status: 'Deployed',
    sensors: ['EGT_Sensor'],
    conditions: 'EGT_Sensor > 650',
  },
  {
    id: 2996,
    workflowName: 'Workflow_draft-1786175540322-e9vknptw',
    description: 'Raise a high alarm if the DEF Quality Sensor reports contamination for two readings in a row',
    status: 'Deployed',
    sensors: ['DEF_Quality_Sensor'],
    conditions: 'DEF_Quality_Sensor = contaminated (x2)',
  },
  {
    id: 2988,
    workflowName: 'Workflow_draft-1786062987410-0lbfqzyv',
    description: 'Raise a critical alarm if Fuel Pressure drops below 250 kPa for 2 minutes',
    status: 'Deployed',
    sensors: ['Fuel_Pressure_Sensor'],
    conditions: 'Fuel_Pressure_Sensor < 250 for 2 min',
  },
];

const STATUS_STYLES: Record<AlertRuleRow['status'], string> = {
  Deployed: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  Draft: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  Disabled: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
};

const STATUS_DOT: Record<AlertRuleRow['status'], string> = {
  Deployed: 'bg-emerald-500',
  Draft: 'bg-amber-500',
  Disabled: 'bg-slate-400',
};

interface AlertAgentViewProps {
  // "+ Add Alert" hands off to the AI Onboarding assistant rather than a
  // manual form — alert rules here are authored the same way devices are,
  // through the chat-driven setup flow.
  onAddAlert: () => void;
}

export const AlertAgentView: React.FC<AlertAgentViewProps> = ({ onAddAlert }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('All');
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);

  const filteredRules = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return ALERT_RULES.filter((rule) => {
      const matchesSearch =
        !term ||
        rule.workflowName.toLowerCase().includes(term) ||
        rule.description.toLowerCase().includes(term) ||
        rule.sensors.some((s) => s.toLowerCase().includes(term)) ||
        rule.conditions.toLowerCase().includes(term) ||
        String(rule.id).includes(term);
      const matchesStatus = selectedStatus === 'All' || rule.status === selectedStatus;
      return matchesSearch && matchesStatus;
    });
  }, [searchTerm, selectedStatus]);

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
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
              placeholder="Search Alert Rules..."
              className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
            />
          </div>

          {/* Status Filter */}
          <select
            value={selectedStatus}
            onChange={(e) => {
              setSelectedStatus(e.target.value);
              setCurrentPage(1);
            }}
            className="py-2 px-3 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 focus:outline-none focus:border-sky-500 cursor-pointer"
          >
            <option value="All">Select Status (All)</option>
            <option value="Deployed">Deployed</option>
            <option value="Draft">Draft</option>
            <option value="Disabled">Disabled</option>
          </select>
        </div>

        {/* Add Alert — hands off to the AI Onboarding assistant, same as "Setup with AI" on Devices */}
        <button
          id="add-alert-btn"
          onClick={onAddAlert}
          className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Sparkles className="w-4 h-4" />
          <span>Add Alert</span>
        </button>
      </div>

      {/* Main Table — matches Device Management's table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold text-xs">
              <tr>
                <th className="py-3 px-4 text-center">ID</th>
                <th className="py-3 px-4">Workflow Name</th>
                <th className="py-3 px-4 min-w-[260px]">Description</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Sensors</th>
                <th className="py-3 px-4 min-w-[220px]">Conditions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium text-slate-800 dark:text-slate-200">
              {paginatedRules.length > 0 ? (
                paginatedRules.map((rule) => (
                  <tr
                    key={rule.id}
                    className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors align-top"
                  >
                    <td className="py-3 px-4 text-center font-mono font-medium text-slate-400">
                      {rule.id}
                    </td>
                    <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white max-w-[220px] break-words">
                      {rule.workflowName}
                    </td>
                    <td className="py-3 px-4 font-normal text-slate-600 dark:text-slate-400 max-w-[320px]">
                      {rule.description}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border ${STATUS_STYLES[rule.status]}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${STATUS_DOT[rule.status]}`}></span>
                        {rule.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-normal text-slate-600 dark:text-slate-400">
                      {rule.sensors.join(', ')}
                    </td>
                    <td className="py-3 px-4 font-mono font-normal text-[11px] text-slate-500 dark:text-slate-400">
                      {rule.conditions}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-400 font-sans">
                    No alert rules found matching criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination — matches Device Management's footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400 font-sans">
          <div>
            Total Rows: <span className="font-semibold text-slate-800 dark:text-slate-200">{totalRows}</span>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span>Rows per page:</span>
              <select
                value={rowsPerPage}
                onChange={(e) => {
                  setRowsPerPage(Number(e.target.value));
                  setCurrentPage(1);
                }}
                className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-slate-700 dark:text-slate-200 text-xs focus:outline-none"
              >
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
            </div>

            <div className="flex items-center gap-1">
              <button
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
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
