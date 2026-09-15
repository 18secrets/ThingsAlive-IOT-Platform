import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type {
  Account, BatchResult, DeviceEvent, InventoryState, PooledDevice,
} from '../../lib/types';
import { Page } from '../../shell/Shell';
import { Badge, Button, Card, Empty, Field, Problem, Td, Th } from '../../shell/ui';

const STATES: { value: InventoryState | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'in-stock', label: 'In stock' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'retired', label: 'Retired' },
];

/**
 * Things Alive's stock ledger.
 *
 * Assigning is commercial and claiming is physical, and they are different columns
 * here because they are different acts by different people: a device can sit in a
 * customer's account for a month before anybody bolts it to a machine. Nothing on this
 * screen claims a device — that is the customer's to do.
 */
export function DevicePool() {
  const [devices, setDevices] = useState<PooledDevice[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [state, setState] = useState<InventoryState | 'all'>('all');
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [registering, setRegistering] = useState(false);
  const [outcome, setOutcome] = useState<{ title: string; results: BatchResult[] } | null>(null);
  const [history, setHistory] = useState<{ imei: string; events: DeviceEvent[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setProblem(null);
    try {
      const query = state === 'all' ? '' : `?state=${state}`;
      const [pool, accts] = await Promise.all([
        api.get<PooledDevice[]>(`/inventory/pool${query}`),
        api.get<Account[]>('/accounts'),
      ]);
      setDevices(pool);
      setAccounts(accts);
      // A selection that survives a filter change points at rows nobody can see, and
      // the next bulk action surprises somebody.
      setSelected(new Set());
    } catch (err) {
      setDevices([]);
      setProblem(err instanceof ApiError ? err.message : 'Could not load the pool.');
    }
  }, [state]);

  useEffect(() => { void load(); }, [load]);

  const chosen = useMemo(() => [...selected], [selected]);

  async function act(
    title: string,
    run: () => Promise<BatchResult[] | { registered: number; alreadyKnown: number }>,
  ) {
    setBusy(true);
    setProblem(null);
    try {
      const result = await run();
      if (Array.isArray(result)) setOutcome({ title, results: result });
      await load();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : `${title} failed.`);
    } finally {
      setBusy(false);
    }
  }

  function assign() {
    const tenantId = window.prompt(
      `Assign ${chosen.length} device(s) to which account?\n\n`
      + accounts.map((a) => `  ${a.tenantId}  —  ${a.name}`).join('\n'),
    );
    if (!tenantId?.trim()) return;
    void act('Assign', () => api.post<BatchResult[]>('/inventory/assign', {
      imeis: chosen, tenantId: tenantId.trim(),
    }));
  }

  function withReason(verb: 'release' | 'retire') {
    // The platform requires a reason for both, and it is right to: a device that left
    // an account without one is a support ticket nobody can answer six months later.
    const reason = window.prompt(`Reason for ${verb === 'release' ? 'releasing' : 'retiring'} ${chosen.length} device(s):`);
    if (!reason?.trim()) return;
    void act(verb === 'release' ? 'Release' : 'Retire', () =>
      api.post<BatchResult[]>(`/inventory/${verb}`, { imeis: chosen, reason: reason.trim() }));
  }

  return (
    <Page
      title="Device pool"
      lede="Every logger Things Alive holds, before and after it belongs to anybody. Registering, assigning, releasing and retiring are commercial acts; fitting a device to a machine is the customer's, and happens in their console."
      right={<Button onClick={() => setRegistering(true)}>Register stock</Button>}
    >
      {problem && <Problem onRetry={load}>{problem}</Problem>}

      {registering && (
        <RegisterStock
          onCancel={() => setRegistering(false)}
          onDone={() => { setRegistering(false); void load(); }}
        />
      )}

      {outcome && <Outcome title={outcome.title} results={outcome.results} onDone={() => setOutcome(null)} />}

      {history && <History imei={history.imei} events={history.events} onDone={() => setHistory(null)} />}

      <Card
        title="Stock"
        right={
          <div className="flex items-center gap-1">
            {STATES.map((s) => (
              <button
                key={s.value}
                onClick={() => setState(s.value)}
                className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
                  state === s.value ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        }
      >
        {chosen.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-5 py-3">
            <span className="text-xs font-medium text-slate-700">{chosen.length} selected</span>
            <div className="flex-1" />
            <Button variant="ghost" disabled={busy} onClick={assign}>Assign to account</Button>
            <Button variant="ghost" disabled={busy} onClick={() => withReason('release')}>Release to stock</Button>
            <Button
              variant="ghost" disabled={busy}
              onClick={() => void act('Return to stock', () =>
                api.post<BatchResult[]>('/inventory/return-to-stock', { imeis: chosen }))}
            >
              Return from retired
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => withReason('retire')}>Retire</Button>
          </div>
        )}

        {devices === null ? (
          <Empty title="Loading…" />
        ) : devices.length === 0 ? (
          <Empty title={state === 'all' ? 'The pool is empty' : `Nothing is ${state}`}>
            {state === 'all'
              ? 'Register a delivery to add stock. Re-running the same delivery note is a no-op, so a duplicated paste costs nothing.'
              : 'Try another state — the devices may be there.'}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-100">
                <tr>
                  <Th className="w-8">
                    <input
                      type="checkbox"
                      checked={selected.size === devices.length && devices.length > 0}
                      onChange={(e) => setSelected(e.target.checked ? new Set(devices.map((d) => d.imei)) : new Set())}
                    />
                  </Th>
                  <Th>IMEI</Th><Th>State</Th><Th>Account</Th><Th>Fitted to</Th>
                  <Th>Model</Th><Th>Batch</Th><Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {devices.map((d) => (
                  <tr key={d.imei}>
                    <Td>
                      <input
                        type="checkbox"
                        checked={selected.has(d.imei)}
                        onChange={(e) => setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(d.imei); else next.delete(d.imei);
                          return next;
                        })}
                      />
                    </Td>
                    <Td className="font-mono text-xs text-slate-900">{d.imei}</Td>
                    <Td><StateBadge state={d.state} /></Td>
                    <Td>
                      {d.tenantId
                        ? <span className="font-mono text-xs">{d.tenantId}</span>
                        : <span className="text-slate-400">—</span>}
                    </Td>
                    <Td>
                      {d.equipmentExternalId
                        ? <span className="font-mono text-xs">{d.equipmentExternalId}</span>
                        : <span className="text-slate-400">not fitted</span>}
                    </Td>
                    <Td>{d.model ?? <span className="text-slate-400">—</span>}</Td>
                    <Td>{d.batchRef ?? <span className="text-slate-400">—</span>}</Td>
                    <Td className="text-right">
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          try {
                            const events = await api.get<DeviceEvent[]>(`/inventory/history/${d.imei}`);
                            setHistory({ imei: d.imei, events });
                          } catch (err) {
                            setProblem(err instanceof ApiError ? err.message : 'Could not read that history.');
                          }
                        }}
                      >
                        History
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
}

function StateBadge({ state }: { state: InventoryState }) {
  if (state === 'assigned') return <Badge tone="ok">Assigned</Badge>;
  if (state === 'retired') return <Badge tone="crit">Retired</Badge>;
  return <Badge>In stock</Badge>;
}

function RegisterStock({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const [imeis, setImeis] = useState('');
  const [model, setModel] = useState('');
  const [batchRef, setBatchRef] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ registered: number; alreadyKnown: number } | null>(null);

  const list = imeis.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setProblem(null);
    try {
      const result = await api.post<{ registered: number; alreadyKnown: number }>('/inventory/register', {
        devices: list.map((imei) => ({
          imei,
          ...(model.trim() ? { model: model.trim() } : {}),
          ...(batchRef.trim() ? { batchRef: batchRef.trim() } : {}),
        })),
      });
      setDone(result);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not register that stock.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Card title="Stock registered" right={<Button variant="ghost" onClick={onDone}>Done</Button>}>
        <p className="px-5 py-5 text-xs leading-relaxed text-slate-600">
          <strong className="text-slate-900">{done.registered}</strong> new device(s) added
          {done.alreadyKnown > 0 && (
            <>, and <strong className="text-slate-900">{done.alreadyKnown}</strong> already
            known and left exactly as they were — re-running a delivery note is a no-op, so
            a duplicated paste costs nothing</>
          )}.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="Register arriving stock"
      note="An IMEI is the whole identity here: it is globally unique by construction, and stock comes from a purchase order rather than a source system."
    >
      <form onSubmit={submit} className="space-y-4 px-5 py-5">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-700">IMEIs</span>
          <textarea
            required rows={5} value={imeis} onChange={(e) => setImeis(e.target.value)}
            placeholder={'862174040000001\n862174040000002'}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900
                       outline-none placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
          />
          <span className="mt-1 block text-[11px] text-slate-500">
            One per line, or separated by commas. {list.length} recognised.
          </span>
        </label>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Model" placeholder="TA-L200" value={model} onChange={(e) => setModel(e.target.value)} />
          <Field
            label="Delivery reference" placeholder="PO-2026-114"
            value={batchRef} onChange={(e) => setBatchRef(e.target.value)}
            hint="Worth filling in: hardware faults correlate by batch, and the first question after three failures is what else came in that box."
          />
        </div>

        {problem && <Problem>{problem}</Problem>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={busy || list.length === 0}>
            {busy ? 'Registering…' : `Register ${list.length || ''} device${list.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </form>
    </Card>
  );
}

const OUTCOME_WORDS: Record<string, string> = {
  'assigned': 'assigned',
  'already-in-this-account': 'already in that account — nothing changed',
  'held-elsewhere': 'held by another account, so it was left alone',
  'retired': 'retired, and a retired device cannot be assigned',
  'unknown': 'not in the pool at all — check the IMEI',
  'released': 'released back into stock',
  'retired-now': 'retired',
  'returned': 'returned to stock',
  'not-assigned': 'was not assigned to anybody',
};

/**
 * A batch action reports per device, so this does too.
 *
 * Collapsing twelve results into "done" is how somebody discovers three weeks later
 * that two of the loggers they thought they shipped are sitting in another customer's
 * account.
 */
function Outcome({ title, results, onDone }: { title: string; results: BatchResult[]; onDone: () => void }) {
  const notable = results.filter((r) => !['assigned', 'released', 'retired-now', 'returned'].includes(r.outcome));
  return (
    <Card
      title={`${title}: ${results.length - notable.length} of ${results.length} went through`}
      note={notable.length ? 'The rest are listed below with what the platform did instead.' : undefined}
      right={<Button variant="ghost" onClick={onDone}>Done</Button>}
    >
      {notable.length > 0 && (
        <ul className="space-y-1 px-5 py-4">
          {notable.map((r) => (
            <li key={r.imei} className="text-xs text-slate-600">
              <span className="font-mono text-slate-900">{r.imei}</span>
              {' — '}{OUTCOME_WORDS[r.outcome] ?? r.outcome}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function History({ imei, events, onDone }: { imei: string; events: DeviceEvent[]; onDone: () => void }) {
  return (
    <Card
      title={`Where ${imei} has been`}
      note="Across every account, because a device that moved between two customers is one story rather than two."
      right={<Button variant="ghost" onClick={onDone}>Close</Button>}
    >
      {events.length === 0 ? (
        <Empty title="No movements recorded" />
      ) : (
        <ol className="divide-y divide-slate-50">
          {events.map((e) => (
            <li key={e.id} className="flex items-baseline gap-3 px-5 py-2.5 text-xs">
              <span className="w-36 shrink-0 text-slate-400">{new Date(e.at).toLocaleString()}</span>
              <span className="font-semibold text-slate-900">{e.action}</span>
              <span className="text-slate-500">
                {e.fromState ?? 'new'} → {e.toState}
                {e.tenantId && <> · {e.tenantId}</>}
                {e.equipmentExternalId && <> · {e.equipmentExternalId}</>}
              </span>
              {e.reason && <span className="flex-1 text-slate-500">“{e.reason}”</span>}
              <span className="ml-auto shrink-0 text-slate-400">{e.actorUserId}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
