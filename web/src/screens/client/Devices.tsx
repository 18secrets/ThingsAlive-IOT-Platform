import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuthed } from '../../lib/session';
import type { Equipment as Machine, PooledDevice } from '../../lib/types';
import { Page } from '../../shell/Shell';
import { Badge, Button, Card, Empty, Problem, Td, Th } from '../../shell/ui';

/**
 * The loggers in this account, and which machine each one is fitted to.
 *
 * Assigning and claiming are two different acts by two different people. Things Alive
 * assigns a device to an account — a commercial decision — and the customer claims it
 * onto a machine, which is somebody walking out to the yard with a spanner. A device
 * can sit here unfitted for a month, and that is a normal state rather than an error.
 *
 * This is also where the onboarding path ends: a device assigned, a machine added, and
 * the two joined. Until that join exists, telemetry from the logger has nowhere to go.
 */
export function Devices() {
  const { can } = useAuthed();
  const [devices, setDevices] = useState<PooledDevice[] | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const mayClaim = can['device.claim'];

  const load = useCallback(async () => {
    setProblem(null);
    try {
      const [d, m] = await Promise.all([
        api.get<PooledDevice[]>('/inventory/mine'),
        api.get<Machine[]>('/equipment').catch(() => []),
      ]);
      setDevices(d); setMachines(m);
    } catch (err) {
      setDevices([]);
      setProblem(err instanceof ApiError ? err.message : 'Could not load your devices.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const machineName = useMemo(() => {
    const byId = new Map(machines.map((m) => [m.externalId, m.name ?? m.externalId]));
    return (externalId: string | null) => (externalId ? byId.get(externalId) ?? externalId : null);
  }, [machines]);

  const unfitted = (devices ?? []).filter((d) => !d.equipmentExternalId);
  const unmonitored = machines.filter(
    (m) => m.status !== 'retired' && !(devices ?? []).some((d) => d.equipmentExternalId === m.externalId),
  );

  async function claim(device: PooledDevice) {
    const options = machines
      .filter((m) => m.status !== 'retired')
      .map((m) => `  ${m.externalId}  —  ${m.name ?? m.externalId}`).join('\n');
    const code = window.prompt(
      `Fit ${device.imei} to which machine?\n\n${options || '  (no machines in the register yet)'}`,
    );
    if (!code?.trim()) return;
    const target = machines.find((m) => m.externalId === code.trim());
    setBusy(device.imei);
    setProblem(null);
    try {
      await api.post('/inventory/claim', {
        imei: device.imei,
        equipmentExternalId: code.trim(),
        // The machine's own source system, not a guess: a machine adopted from the
        // existing platform carries its origin, and claiming against the wrong one
        // finds nothing and says the machine does not exist.
        sourceSystem: target?.sourceSystem ?? 'ta-2.0',
      });
      await load();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not fit that device.');
    } finally { setBusy(null); }
  }

  async function unclaim(device: PooledDevice) {
    const reason = window.prompt(
      `Take ${device.imei} off ${machineName(device.equipmentExternalId)}?\n\nWhy:`,
    );
    if (!reason?.trim()) return;
    setBusy(device.imei);
    setProblem(null);
    try {
      await api.post('/inventory/unclaim', { imei: device.imei, reason: reason.trim() });
      await load();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not release that device.');
    } finally { setBusy(null); }
  }

  return (
    <Page
      title="Devices"
      lede="The loggers Things Alive has assigned to your account. Fitting one to a machine is yours to do — nobody here knows which generator the logger ended up on."
    >
      {problem && <Problem onRetry={load}>{problem}</Problem>}

      {(unfitted.length > 0 || unmonitored.length > 0) && devices !== null && (
        <Card title="Worth finishing">
          <div className="space-y-2 px-5 py-4 text-xs leading-relaxed text-slate-600">
            {unfitted.length > 0 && (
              <p>
                <strong className="text-slate-900">
                  {unfitted.length} device{unfitted.length === 1 ? '' : 's'} not fitted to anything.
                </strong>{' '}
                Their readings have nowhere to go, so nothing is scored from them.
              </p>
            )}
            {unmonitored.length > 0 && (
              <p>
                <strong className="text-slate-900">
                  {unmonitored.length} machine{unmonitored.length === 1 ? '' : 's'} with no device.
                </strong>{' '}
                They are in the register and silent, which is indistinguishable from a
                machine that is simply not running.
              </p>
            )}
          </div>
        </Card>
      )}

      <Card title="Your devices">
        {devices === null ? (
          <Empty title="Loading…" />
        ) : devices.length === 0 ? (
          <Empty title="No devices in this account">
            Things Alive assigns loggers to your account from their pool. Until one is
            assigned there is nothing to fit, and nothing to read.
          </Empty>
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-100">
              <tr>
                <Th>IMEI</Th><Th>Model</Th><Th>Fitted to</Th><Th>Since</Th><Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {devices.map((d) => (
                <tr key={d.imei}>
                  <Td className="font-mono text-xs text-slate-900">{d.imei}</Td>
                  <Td>{d.model ?? <span className="text-slate-400">—</span>}</Td>
                  <Td>
                    {d.equipmentExternalId
                      ? <span className="font-medium text-slate-900">{machineName(d.equipmentExternalId)}</span>
                      : <Badge tone="warn">not fitted</Badge>}
                  </Td>
                  <Td className="text-slate-500">
                    {d.claimedAt ? new Date(d.claimedAt).toLocaleDateString() : '—'}
                  </Td>
                  <Td className="text-right">
                    {mayClaim && (
                      d.equipmentExternalId
                        ? <Button variant="ghost" disabled={busy === d.imei} onClick={() => unclaim(d)}>
                            Take off
                          </Button>
                        : <Button disabled={busy === d.imei} onClick={() => claim(d)}>
                            Fit to a machine
                          </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Page>
  );
}
