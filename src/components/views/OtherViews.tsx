import React from 'react';
import { 
  Activity, 
  AlertTriangle, 
  Cpu, 
  Globe, 
  Users as UsersIcon, 
  Radio, 
  Settings as SettingsIcon, 
  CheckCircle2, 
  ShieldCheck,
  Zap,
  TrendingUp,
  Clock
} from 'lucide-react';
import { EquipmentItem, DeviceItem, NavigationTab } from '../../types';
import { PmDashboardSummary } from '../../pm/screens/DashboardSummary';

interface DashboardViewProps {
  equipment: EquipmentItem[];
  devices: DeviceItem[];
  onNavigateToDevices: () => void;
  onNavigateToEquipment: () => void;
  onNavigate: (tab: NavigationTab) => void;
  onViewMachine: (machineId: string) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  equipment,
  devices,
  onNavigateToDevices,
  onNavigateToEquipment,
  onNavigate,
  onViewMachine,
}) => {
  return (
    <div className="space-y-10">
      {/*
        Original fleet telematics overview (Fleet Health Index / Active Equipment /
        Online Telematics / Active Diagnostics KPI row, Industrial Telemetry Streams,
        System Health & Telematics OS) is hidden for now — the Predictive Maintenance
        + Monitoring + Reports overview below is the only Dashboard content. Restore
        this block (and drop the props/imports it needs: equipment, devices,
        onNavigateToDevices, onNavigateToEquipment, Activity, AlertTriangle, Zap,
        Radio, TrendingUp) if the fleet telematics cards should come back.

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-5 bg-[#FFFFFF] dark:bg-[#1A1918] border border-[#121212]/15 dark:border-white/15 shadow-xs">
          <div className="flex items-center justify-between text-[10px] font-sans uppercase tracking-[0.2em] font-bold text-[#121212]/60 dark:text-[#FDFCF5]/60">
            <span>Fleet Health Index</span>
            <Activity className="w-4 h-4 text-[#FF4D00]" />
          </div>
          <div className="font-serif text-3xl font-bold text-[#121212] dark:text-[#FDFCF5] mt-1">98.4%</div>
          <div className="text-[11px] text-[#121212]/60 dark:text-[#FDFCF5]/60 mt-1 flex items-center gap-1 font-mono">
            <TrendingUp className="w-3 h-3 text-[#FF4D00]" /> +1.2% this shift
          </div>
        </div>

        <div
          onClick={onNavigateToEquipment}
          className="p-5 bg-[#FFFFFF] dark:bg-[#1A1918] border border-[#121212]/15 dark:border-white/15 shadow-xs hover:border-[#FF4D00] cursor-pointer transition-all"
        >
          <div className="flex items-center justify-between text-[10px] font-sans uppercase tracking-[0.2em] font-bold text-[#121212]/60 dark:text-[#FDFCF5]/60">
            <span>Active Equipment</span>
            <Zap className="w-4 h-4 text-[#121212] dark:text-[#FDFCF5]" />
          </div>
          <div className="font-serif text-3xl font-bold text-[#121212] dark:text-[#FDFCF5] mt-1">{equipment.length} Units</div>
          <div className="text-[11px] text-[#121212]/50 dark:text-[#FDFCF5]/50 mt-1 font-mono">Across 3 industrial plants</div>
        </div>

        <div
          onClick={onNavigateToDevices}
          className="p-5 bg-[#FFFFFF] dark:bg-[#1A1918] border border-[#121212]/15 dark:border-white/15 shadow-xs hover:border-[#FF4D00] cursor-pointer transition-all"
        >
          <div className="flex items-center justify-between text-[10px] font-sans uppercase tracking-[0.2em] font-bold text-[#121212]/60 dark:text-[#FDFCF5]/60">
            <span>Online Telematics</span>
            <Radio className="w-4 h-4 text-[#FF4D00]" />
          </div>
          <div className="font-serif text-3xl font-bold text-[#121212] dark:text-[#FDFCF5] mt-1">
            {devices.filter(d => d.status === 'Online').length} / {devices.length}
          </div>
          <div className="text-[11px] text-[#121212]/60 dark:text-[#FDFCF5]/60 mt-1 font-mono">Real-time CAN/MODBUS streaming</div>
        </div>

        <div className="p-5 bg-[#FFFFFF] dark:bg-[#1A1918] border border-[#121212]/15 dark:border-white/15 shadow-xs">
          <div className="flex items-center justify-between text-[10px] font-sans uppercase tracking-[0.2em] font-bold text-[#121212]/60 dark:text-[#FDFCF5]/60">
            <span>Active Diagnostics</span>
            <AlertTriangle className="w-4 h-4 text-[#FF4D00]" />
          </div>
          <div className="font-serif text-3xl font-bold text-[#121212] dark:text-[#FDFCF5] mt-1">1 Alert</div>
          <div className="text-[11px] text-[#FF4D00] mt-1 font-mono">Device #131 Heartbeat Missing</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-[#FFFFFF] dark:bg-[#1A1918] p-6 border border-[#121212]/15 dark:border-white/15 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] text-base">Industrial Telemetry Streams</h3>
            <span className="text-[10px] font-mono uppercase font-bold bg-[#FF4D00]/10 text-[#FF4D00] border border-[#FF4D00]/30 px-2.5 py-0.5">
              Live Gateway Feed
            </span>
          </div>

          <div className="space-y-3">
            {[
              { plant: 'Lucknow Infrastructure Plant', equip: 'Volvo EC210 Crawler Excavator', param: 'Hydraulic Pump Pressure: 34.2 MPa', status: 'Optimal', time: '1s ago' },
              { plant: 'Lucknow Infrastructure Plant', equip: 'Liebherr LTM 1090-4.2 Crane', param: 'Luffing Cylinder Angle: 54.2°', status: 'Optimal', time: '2s ago' },
              { plant: 'Pune Automotive Plant', equip: 'Dürr Electric Monorail Conveyor', param: 'Chain Tension: 14.8 kN • Speed: 0.4 m/s', status: 'Optimal', time: '3s ago' },
              { plant: 'CBM Central Works', equip: 'Dust Collector Monitoring (KM-400)', param: 'Delta-P: 1.4 kPa • Opacity: 3.2%', status: 'Optimal', time: 'Just now' },
              { plant: 'CBM Central Works', equip: 'PowerCommand Cloud (Gen 4)', param: 'No CAN response on address 0x18', status: 'Offline', time: '4h ago' }
            ].map((feed, i) => (
              <div key={i} className="p-3.5 border border-[#121212]/15 dark:border-white/15 bg-[#FAF9F2] dark:bg-[#151514] flex items-center justify-between text-xs">
                <div>
                  <div className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] flex items-center gap-2">
                    <span>{feed.equip}</span>
                    <span className="text-[10px] font-sans text-[#121212]/50 dark:text-[#FDFCF5]/50 font-normal">({feed.plant})</span>
                  </div>
                  <div className="text-[#121212]/70 dark:text-[#FDFCF5]/70 text-[11px] mt-0.5 font-mono">{feed.param}</div>
                </div>
                <div className="text-right">
                  <span className={`px-2 py-0.5 border text-[10px] font-mono uppercase font-bold ${
                    feed.status === 'Optimal'
                      ? 'bg-[#F4F2EA] dark:bg-stone-800 text-[#121212] dark:text-[#FDFCF5] border-[#121212]/30 dark:border-white/30'
                      : 'bg-[#FF4D00]/10 text-[#FF4D00] border-[#FF4D00]/30'
                  }`}>
                    {feed.status}
                  </span>
                  <div className="text-[10px] font-mono text-[#121212]/40 dark:text-[#FDFCF5]/40 mt-1">{feed.time}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[#FFFFFF] dark:bg-[#1A1918] p-6 border border-[#121212]/15 dark:border-white/15 shadow-xs space-y-4">
          <h3 className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] text-base">System Health & Telematics OS</h3>
          <div className="space-y-3 text-xs">
            <div className="p-3 bg-[#FAF9F2] dark:bg-[#151514] border border-[#121212]/15 dark:border-white/15">
              <span className="text-[10px] font-sans uppercase tracking-[0.14em] text-[#121212]/50 dark:text-[#FDFCF5]/50 font-bold">Operating System</span>
              <div className="font-mono font-bold text-[#121212] dark:text-[#FDFCF5] text-sm mt-0.5">ThingsAlive Telematics v1.0.5</div>
            </div>
            <div className="p-3 bg-[#FAF9F2] dark:bg-[#151514] border border-[#121212]/15 dark:border-white/15">
              <span className="text-[10px] font-sans uppercase tracking-[0.14em] text-[#121212]/50 dark:text-[#FDFCF5]/50 font-bold">MODBUS / CAN Ingestion</span>
              <div className="font-mono font-bold text-[#FF4D00] text-sm mt-0.5">Synchronized (502 / 2939)</div>
            </div>
            <div className="p-3 bg-[#FAF9F2] dark:bg-[#151514] border border-[#121212]/15 dark:border-white/15">
              <span className="text-[10px] font-sans uppercase tracking-[0.14em] text-[#121212]/50 dark:text-[#FDFCF5]/50 font-bold">Cloud Database</span>
              <div className="font-mono font-bold text-[#121212] dark:text-[#FDFCF5] text-sm mt-0.5">Fleet State Active</div>
            </div>
          </div>
        </div>
      </div>
      */}

      <PmDashboardSummary onNavigate={onNavigate} onViewMachine={onViewMachine} />
    </div>
  );
};

export const AlertRulesView: React.FC = () => (
  <div className="bg-[#FFFFFF] dark:bg-[#1A1918] p-6 border border-[#121212]/15 dark:border-white/15 shadow-xs space-y-5 text-xs">
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <h3 className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] text-xl">Telemetry Alert Thresholds & Rules</h3>
        <p className="text-[#121212]/60 dark:text-[#FDFCF5]/60 font-sans mt-0.5">Configure continuous rule evaluation for differential pressure, engine thermal spikes, and fuel loss events.</p>
      </div>
      <button className="px-4 py-2 bg-[#121212] text-[#FDFCF5] hover:bg-[#FF4D00] hover:text-white dark:bg-[#FDFCF5] dark:text-[#121212] dark:hover:bg-[#FF4D00] dark:hover:text-white border border-[#121212] dark:border-white text-xs font-sans uppercase tracking-[0.14em] font-bold transition-colors cursor-pointer shrink-0">
        + New Alert Rule
      </button>
    </div>

    <div className="divide-y divide-[#121212]/10 dark:divide-white/10">
      {[
        { name: 'Dust Collector Differential Pressure High', trigger: 'Delta-P > 2.8 kPa for 5 mins', target: 'Cement & Building Materials', severity: 'High' },
        { name: 'Excavator Hydraulic Oil Overheat', trigger: 'Reservoir Temp > 92°C', target: 'Infrastructure Earthmovers', severity: 'Critical' },
        { name: 'Conveyor Misalignment Drift Alarm', trigger: 'Side-travel > 15 mm', target: 'Vehicle Assembly Conveyors', severity: 'Medium' },
        { name: 'Harsh Fuel Level Drop', trigger: 'Fuel Level Delta > -20L in < 2 mins', target: 'Mining Haulage Fleet', severity: 'Critical' }
      ].map((rule, idx) => (
        <div key={idx} className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <div className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] text-sm">{rule.name}</div>
            <div className="text-[11px] text-[#121212]/60 dark:text-[#FDFCF5]/60 font-mono mt-0.5">Condition: {rule.trigger} • Applies to: {rule.target}</div>
          </div>
          <span className={`self-start sm:self-center px-2.5 py-0.5 border text-[10px] font-mono uppercase font-bold ${
            rule.severity === 'Critical' ? 'bg-[#FF4D00]/10 text-[#FF4D00] border-[#FF4D00]/40' :
            rule.severity === 'High' ? 'bg-[#F4F2EA] dark:bg-stone-800 text-[#121212] dark:text-[#FDFCF5] border-[#121212]/30 dark:border-white/30' :
            'bg-[#FAF9F2] dark:bg-[#151514] text-[#121212]/70 dark:text-[#FDFCF5]/70 border-[#121212]/20 dark:border-white/20'
          }`}>
            {rule.severity}
          </span>
        </div>
      ))}
    </div>
  </div>
);

export const VendorsView: React.FC = () => (
  <div className="bg-[#FFFFFF] dark:bg-[#1A1918] p-6 border border-[#121212]/15 dark:border-white/15 shadow-xs space-y-5 text-xs">
    <h3 className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] text-xl">OEM & Telematics Hardware Vendors</h3>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {[
        { name: 'Eicher Motors', type: 'OEM Gateway Integration', devices: 4, status: 'Active Partner' },
        { name: 'JCB India', type: 'LiveLink Telematics API', devices: 6, status: 'Active Partner' },
        { name: 'Larsen Engineering', type: 'Fieldbus Instrumentation', devices: 3, status: 'Active Partner' },
        { name: 'Tata Hitachi', type: 'Conveyor & Excavator Edge', devices: 5, status: 'Active Partner' },
        { name: 'Durr pvt lts', type: 'Paint & Assembly Telematics', devices: 2, status: 'Active Partner' },
        { name: 'BEML', type: 'Heavy Earthmover Protocol Suite', devices: 5, status: 'Active Partner' }
      ].map((v, i) => (
        <div key={i} className="p-4 border border-[#121212]/15 dark:border-white/15 bg-[#FAF9F2] dark:bg-[#151514] space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] text-sm">{v.name}</span>
            <span className="text-[10px] font-mono text-[#FF4D00] uppercase font-bold">{v.status}</span>
          </div>
          <p className="text-[11px] text-[#121212]/60 dark:text-[#FDFCF5]/60 font-sans">{v.type}</p>
          <div className="text-[11px] text-[#121212]/40 dark:text-[#FDFCF5]/40 font-mono pt-2 border-t border-[#121212]/10 dark:border-white/10">{v.devices} devices onboarded</div>
        </div>
      ))}
    </div>
  </div>
);

export const UsersView: React.FC = () => (
  <div className="bg-[#FFFFFF] dark:bg-[#1A1918] p-6 border border-[#121212]/15 dark:border-white/15 shadow-xs space-y-5 text-xs">
    <h3 className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] text-xl">Users & Access Control</h3>
    <div className="divide-y divide-[#121212]/10 dark:divide-white/10">
      {[
        { name: 'Telematics Administrator', email: 'admin@thingsalive.io', role: 'Super Admin', plant: 'All Plants' },
        { name: 'Rajesh Sharma', email: 'r.sharma@lucknow.ccl', role: 'Plant Maintenance Lead', plant: 'Lucknow Infrastructure Plant' },
        { name: 'Priya Deshmukh', email: 'p.deshmukh@pune.ccl', role: 'Robotics Assembly Specialist', plant: 'Pune Automotive Plant' },
        { name: 'Kavita Mehta', email: 'k.mehta@cbm.ccl', role: 'Condition Monitoring Engineer', plant: 'CBM Central Works' }
      ].map((u, i) => (
        <div key={i} className="py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 border border-[#121212]/20 dark:border-white/20 bg-[#F4F2EA] dark:bg-stone-800 text-[#121212] dark:text-[#FDFCF5] font-serif font-bold flex items-center justify-center">
              {u.name.charAt(0)}
            </div>
            <div>
              <div className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5]">{u.name}</div>
              <div className="text-[11px] font-mono text-[#121212]/50 dark:text-[#FDFCF5]/50">{u.email}</div>
            </div>
          </div>
          <div className="text-right">
            <span className="font-sans font-bold text-[#121212] dark:text-[#FDFCF5]">{u.role}</span>
            <div className="text-[10px] font-mono text-[#121212]/50 dark:text-[#FDFCF5]/50">{u.plant}</div>
          </div>
        </div>
      ))}
    </div>
  </div>
);

export const DiagnosticsView: React.FC = () => (
  <div className="bg-[#FFFFFF] dark:bg-[#1A1918] p-6 border border-[#121212]/15 dark:border-white/15 shadow-xs space-y-4 text-xs font-mono">
    <div className="flex items-center justify-between font-sans">
      <h3 className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] text-xl">Live Bus Diagnostics & Telematics Sniffer</h3>
      <span className="text-xs text-[#FF4D00] flex items-center gap-1.5 font-mono uppercase font-bold">
        <span className="w-2 h-2 rounded-full bg-[#FF4D00] animate-pulse"></span>
        Streaming CAN / MODBUS Packets
      </span>
    </div>

    <div className="bg-[#121212] text-[#FDFCF5]/90 p-4 border border-white/15 space-y-2 overflow-x-auto text-[11px] max-h-96 overflow-y-auto font-mono">
      <div className="text-emerald-400">[10:42:01.214] RX J1939 CAN ID 0x18FEEE00 Len:8 Data: FF 21 00 48 3C 12 00 00 (Engine Coolant: 84°C)</div>
      <div className="text-[#FF4D00]">[10:42:01.350] RX MODBUS-TCP 192.168.1.104:502 TransID: 4128 Func: 03 Reg: 40001 Val: 1420 (Delta-P 1.42 kPa)</div>
      <div className="text-emerald-400">[10:42:01.500] RX J1939 CAN ID 0x18FEF200 Len:8 Data: A2 18 00 00 00 00 00 00 (Fuel Rate: 14.2 L/h)</div>
      <div className="text-stone-300">[10:42:01.620] RX PROFINET IO-Cycle 34964 Rack:0 Slot:2 Sub:1 Status: VALID Cyclic_Counter: 98124</div>
      <div className="text-emerald-400">[10:42:01.810] RX J1939 CAN ID 0x18FEE600 Len:8 Data: 00 00 00 00 00 00 00 00 (Axle G-Force: 0.02g Normal)</div>
      <div className="text-[#FF4D00] font-bold">[10:42:02.004] PING Device #131 IMEI:356789104590731 &rarr; TIMEOUT NO ACK RECEIVED (Retry 3 of 5)</div>
    </div>
  </div>
);

export const SettingsView: React.FC = () => (
  <div className="bg-[#FFFFFF] dark:bg-[#1A1918] p-6 border border-[#121212]/15 dark:border-white/15 shadow-xs space-y-5 text-xs">
    <h3 className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] text-xl">Global Telematics OS Settings</h3>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="p-5 border border-[#121212]/15 dark:border-white/15 bg-[#FAF9F2] dark:bg-[#151514] space-y-2.5">
        <div className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] text-sm">Telemetry Packet Polling Frequency</div>
        <p className="text-[#121212]/60 dark:text-[#FDFCF5]/60 font-sans">Default rate at which cellular and edge modems send status updates.</p>
        <select className="w-full border border-[#121212]/20 dark:border-white/20 p-2 text-xs bg-[#FDFCF5] dark:bg-[#121212] text-[#121212] dark:text-[#FDFCF5] focus:outline-none focus:border-[#FF4D00]">
          <option>High Frequency (1 Second - Continuous)</option>
          <option>Standard (5 Seconds)</option>
          <option>Eco Battery (30 Seconds)</option>
        </select>
      </div>

      <div className="p-5 border border-[#121212]/15 dark:border-white/15 bg-[#FAF9F2] dark:bg-[#151514] space-y-2.5">
        <div className="font-serif font-bold text-[#121212] dark:text-[#FDFCF5] text-sm">Automatic Device Provisioning</div>
        <p className="text-[#121212]/60 dark:text-[#FDFCF5]/60 font-sans">Auto-link incoming IMEIs with matching preconfigured plant tool profiles.</p>
        <div className="flex items-center gap-2 pt-1">
          <input type="checkbox" defaultChecked className="accent-[#FF4D00] w-4 h-4 cursor-pointer" />
          <span className="font-sans font-bold text-[#121212] dark:text-[#FDFCF5]">Enabled</span>
        </div>
      </div>
    </div>
  </div>
);
