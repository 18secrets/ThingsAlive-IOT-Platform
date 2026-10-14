import React, { useMemo } from 'react';
import { Building2, Cpu, Info, Wrench } from 'lucide-react';
import { ClientAccount } from '../../types';
import { apiListAllEquipment, apiListDevicePool } from '../../lib/api';
import { useSlot } from '../../lib/useSlot';

interface MasterAdminDashboardProps {
  clients: ClientAccount[];
}

/**
 * Master Admin's overview on what the backend can answer across every account: the
 * accounts, the device pool (the stock ledger) and every account's equipment register.
 * Device connectivity and onboarding sessions used to be drawn from sample data here;
 * both are per-tenant reads today (device-health, onboarding/status answer for the
 * caller's own account, which for a platform user is none), so they are named as
 * missing rather than shown with numbers nobody measured.
 */
export const MasterAdminDashboard: React.FC<MasterAdminDashboardProps> = ({ clients }) => {
  const pool = useSlot(() => apiListDevicePool(), []);
  const equipment = useSlot(() => apiListAllEquipment(), []);

  const activeClientsCount = clients.filter((c) => c.status === 'Active').length;
  const devices = pool.state === 'ok' ? pool.data : [];
  // `/equipment/all` also returns tenants that are not client accounts (the seeded
  // demo tenant), which the per-client panel cannot show — counting them in the tile
  // would make the two disagree, so they are named separately instead.
  const clientIds = new Set(clients.map((c) => c.id));
  const allActive = equipment.state === 'ok' ? equipment.data.filter((e) => e.status === 'active') : [];
  const machines = allActive.filter((e) => clientIds.has(e.tenantId));
  const outsideAccounts = allActive.length - machines.length;

  const byClient = useMemo(() => clients
    .map((c) => ({
      id: c.id,
      name: c.clientName,
      devices: devices.filter((d) => d.tenantId === c.id && d.state === 'assigned').length,
      equipment: machines.filter((e) => e.tenantId === c.id).length,
    }))
    .sort((a, b) => (b.devices + b.equipment) - (a.devices + a.equipment)),
  [clients, devices, machines]);
  const widest = Math.max(1, ...byClient.map((c) => Math.max(c.devices, c.equipment)));

  const poolCounts = {
    inStock: devices.filter((d) => d.state === 'in-stock').length,
    assigned: devices.filter((d) => d.state === 'assigned').length,
    retired: devices.filter((d) => d.state === 'retired').length,
  };
  const poolTotal = Math.max(1, devices.length);

  const count = (slot: { state: string }, n: number) =>
    slot.state === 'loading' ? '…' : slot.state === 'unavailable' ? '—' : n;

  return (
    <div id="master-admin-dashboard-view" className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Tile label="Total Clients" value={clients.length} note={`${activeClientsCount} active`} tone="sky" icon={<Building2 className="w-5 h-5" />} />
        <Tile
          label="Devices in pool"
          value={count(pool, devices.length)}
          note={pool.state === 'unavailable' ? 'Could not read the device pool' : `${poolCounts.assigned} assigned · ${poolCounts.inStock} in stock`}
          tone="emerald"
          icon={<Cpu className="w-5 h-5" />}
        />
        <Tile
          label="Total Equipment"
          value={count(equipment, machines.length)}
          note={equipment.state === 'unavailable'
            ? 'Could not read the equipment register'
            : `${machines.filter((e) => e.equipmentClassSlug).length} with an equipment class`
              + (outsideAccounts ? ` · ${outsideAccounts} more outside client accounts` : '')}
          tone="amber"
          icon={<Wrench className="w-5 h-5" />}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Panel title="By client" subtitle="Assigned devices and active equipment per account">
          {byClient.length === 0 ? (
            <p className="text-sm text-slate-400 py-6 text-center">No client accounts yet.</p>
          ) : (
            <div className="space-y-3">
              {byClient.map((c) => (
                <div key={c.id} className="space-y-1">
                  <div className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{c.name}</div>
                  <Bar label="Devices" value={c.devices} max={widest} color="bg-emerald-500" />
                  <Bar label="Equipment" value={c.equipment} max={widest} color="bg-amber-500" />
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Device pool" subtitle="Every logger Things Alive holds, by where it is in its life">
          {pool.state !== 'ok' ? (
            <p className="text-sm text-slate-400 py-6 text-center">{pool.state === 'loading' ? 'Loading…' : 'Could not read the device pool.'}</p>
          ) : (
            <div className="space-y-2.5">
              <Bar label="Assigned" value={poolCounts.assigned} max={poolTotal} color="bg-emerald-500" />
              <Bar label="In stock" value={poolCounts.inStock} max={poolTotal} color="bg-sky-500" />
              <Bar label="Retired" value={poolCounts.retired} max={poolTotal} color="bg-slate-400" />
            </div>
          )}
        </Panel>
      </div>

      <div className="flex items-start gap-2 text-[11px] text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>Device connectivity and onboarding activity across clients are not shown: the backend answers both per account only, with no cross-tenant read for Master Admin yet.</span>
      </div>
    </div>
  );
};

const TONES = {
  sky: 'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400',
  emerald: 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400',
  amber: 'bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400',
};

const Tile: React.FC<{ label: string; value: React.ReactNode; note: string; tone: keyof typeof TONES; icon: React.ReactNode }> = ({ label, value, note, tone, icon }) => (
  <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
    <div>
      <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{value}</div>
      <div className="text-[11px] text-slate-400 mt-1">{note}</div>
    </div>
    <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${TONES[tone]}`}>{icon}</div>
  </div>
);

const Panel: React.FC<{ title: string; subtitle: string; children: React.ReactNode }> = ({ title, subtitle, children }) => (
  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs p-5 space-y-4">
    <div>
      <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">{title}</h3>
      <p className="text-[11px] text-slate-400">{subtitle}</p>
    </div>
    {children}
  </div>
);

const Bar: React.FC<{ label: string; value: number; max: number; color: string }> = ({ label, value, max, color }) => (
  <div className="flex items-center gap-2 text-[11px]">
    <span className="w-16 shrink-0 text-slate-500 dark:text-slate-400">{label}</span>
    <div className="flex-1 h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${(value / max) * 100}%` }} />
    </div>
    <span className="w-6 text-right font-mono text-slate-700 dark:text-slate-200">{value}</span>
  </div>
);
