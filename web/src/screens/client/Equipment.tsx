import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuthed } from '../../lib/session';
import type { Equipment as Machine, EquipmentClass, Placement, Plant } from '../../lib/types';
import { Page } from '../../shell/Shell';
import { Badge, Button, Card, Empty, Field, Problem, Td, Th } from '../../shell/ui';

/**
 * The customer's own sites and machines (tasks P1-85, P1-86).
 *
 * Master data is the client's, settled deliberately: Things Alive knows what a diesel
 * generator is, and the customer knows which ones they own and where they are. Nothing
 * on this screen is copied from anywhere — it is typed by the people who can see the
 * machines.
 *
 * Read by everybody in the account, written by the roles that hold `equipment.write`.
 * A support engineer who can see the register but not change it gets the same screen
 * without the buttons, rather than a different screen or a wall of disabled controls.
 */
export function Equipment() {
  const { can } = useAuthed();
  const [plants, setPlants] = useState<Plant[] | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [classes, setClasses] = useState<EquipmentClass[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [plantFilter, setPlantFilter] = useState<string | 'all'>('all');
  const [addingPlant, setAddingPlant] = useState(false);
  const [addingMachine, setAddingMachine] = useState(false);
  const [history, setHistory] = useState<{ machine: Machine; placements: Placement[] } | null>(null);

  const mayWrite = can['equipment.write'];

  const load = useCallback(async () => {
    setProblem(null);
    try {
      const [p, m, c] = await Promise.all([
        api.get<Plant[]>('/equipment/plants'),
        api.get<Machine[]>('/equipment'),
        // The classes this account was granted. Used to offer a class when adding a
        // machine — an unclassified machine is scored by nothing and matched by no
        // class-scoped alert rule, which is a quiet way to own a machine nobody watches.
        api.get<EquipmentClass[]>('/catalog/equipment-classes').catch(() => []),
      ]);
      setPlants(p); setMachines(m); setClasses(c);
    } catch (err) {
      setPlants([]);
      setProblem(err instanceof ApiError ? err.message : 'Could not load the register.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (run: () => Promise<unknown>) => {
    setProblem(null);
    try { await run(); await load(); }
    catch (err) { setProblem(err instanceof ApiError ? err.message : 'That did not go through.'); }
  };

  const plantName = useMemo(() => {
    const byId = new Map((plants ?? []).map((p) => [p.id, p.name]));
    return (id: string | null) => (id ? byId.get(id) ?? 'unknown site' : null);
  }, [plants]);

  const shown = plantFilter === 'all'
    ? machines
    : machines.filter((m) => m.plantId === plantFilter);

  const unclassified = machines.filter((m) => !m.equipmentClassSlug).length;

  return (
    <Page
      title="Equipment"
      lede="Your sites and your machines. This register is yours: Things Alive knows what a kind of machine is, and you know which ones you own and where they are."
      right={mayWrite && (
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setAddingPlant(true)}>Add site</Button>
          <Button onClick={() => setAddingMachine(true)}>Add machine</Button>
        </div>
      )}
    >
      {problem && <Problem onRetry={load}>{problem}</Problem>}

      {addingPlant && (
        <NewPlant onCancel={() => setAddingPlant(false)}
          onDone={() => { setAddingPlant(false); }} act={act} />
      )}

      {addingMachine && (
        <NewMachine
          plants={(plants ?? []).filter((p) => p.status === 'active')}
          classes={classes}
          onCancel={() => setAddingMachine(false)}
          onDone={() => { setAddingMachine(false); }}
          act={act}
        />
      )}

      {history && (
        <Card
          title={`Where ${history.machine.name ?? history.machine.externalId} has been`}
          right={<Button variant="ghost" onClick={() => setHistory(null)}>Close</Button>}
        >
          {history.placements.length === 0 ? (
            <Empty title="No moves recorded" />
          ) : (
            <ol className="divide-y divide-slate-50">
              {history.placements.map((p) => (
                <li key={p.id} className="flex items-baseline gap-3 px-5 py-2.5 text-xs">
                  <span className="w-36 shrink-0 text-slate-400">{new Date(p.at).toLocaleString()}</span>
                  <span className="text-slate-700">
                    {plantName(p.fromPlantId) ?? 'off site'} → {plantName(p.plantId) ?? 'off site'}
                  </span>
                  {p.reason && <span className="flex-1 text-slate-500">“{p.reason}”</span>}
                  <span className="ml-auto shrink-0 text-slate-400">{p.movedBy}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}

      {unclassified > 0 && (
        <Card>
          <p className="px-5 py-4 text-xs leading-relaxed text-slate-600">
            <strong className="text-slate-900">
              {unclassified} machine{unclassified === 1 ? ' has' : 's have'} no equipment class.
            </strong>{' '}
            Nothing scores them, and no alert rule written about a kind of machine matches
            them — including the ones that arrived with your catalog. They are owned and
            unwatched, which looks the same as fine.
          </p>
        </Card>
      )}

      <Card
        title="Machines"
        right={
          <select
            value={plantFilter}
            onChange={(e) => setPlantFilter(e.target.value)}
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-700 outline-none
                       focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
          >
            <option value="all">Every site</option>
            {(plants ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        }
      >
        {plants === null ? (
          <Empty title="Loading…" />
        ) : shown.length === 0 ? (
          <Empty title={machines.length === 0 ? 'No machines yet' : 'Nothing at this site'}>
            {machines.length === 0
              ? 'Add a site first, then the machines on it. A machine needs a code that is unique inside your account — two customers both calling one "DG-1" is ordinary.'
              : 'Machines move between sites; the filter follows where they are now.'}
          </Empty>
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-100">
              <tr>
                <Th>Machine</Th><Th>Code</Th><Th>Site</Th><Th>Class</Th><Th>Tier</Th><Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {shown.map((m) => (
                <tr key={m.externalId}>
                  <Td className="font-medium text-slate-900">
                    {m.name ?? m.externalId}
                    {m.manufacturer && (
                      <span className="ml-2 text-[11px] font-normal text-slate-400">
                        {m.manufacturer}{m.modelNumber ? ` ${m.modelNumber}` : ''}
                      </span>
                    )}
                  </Td>
                  <Td className="font-mono text-xs text-slate-500">{m.externalId}</Td>
                  <Td>{plantName(m.plantId) ?? <span className="text-slate-400">off site</span>}</Td>
                  <Td>
                    {m.equipmentClassSlug
                      ? <span className="font-mono text-xs">{m.equipmentClassSlug}</span>
                      : <Badge tone="warn">unclassified</Badge>}
                  </Td>
                  <Td className="text-slate-500">{m.tier}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          try {
                            const placements = await api.get<Placement[]>(
                              `/equipment/${m.sourceSystem}/${m.externalId}/placements`);
                            setHistory({ machine: m, placements });
                          } catch (err) {
                            setProblem(err instanceof ApiError ? err.message : 'Could not read that history.');
                          }
                        }}
                      >
                        History
                      </Button>
                      {mayWrite && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            const to = window.prompt(
                              `Move ${m.name ?? m.externalId} to which site?\n\n`
                              + (plants ?? []).map((p) => `  ${p.id}  —  ${p.name}`).join('\n')
                              + '\n\nLeave blank to take it off site without retiring it.',
                            );
                            if (to === null) return;
                            const reason = window.prompt('Why is it moving?');
                            if (!reason?.trim()) return;
                            void act(() => api.post(`/equipment/${m.sourceSystem}/${m.externalId}/move`, {
                              toPlantId: to.trim() || null, reason: reason.trim(),
                            }));
                          }}
                        >
                          Move
                        </Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Sites">
        {plants === null ? (
          <Empty title="Loading…" />
        ) : plants.length === 0 ? (
          <Empty title="No sites yet">
            A site is where machines are. Adding one is the first thing to do in a new
            account, because a machine with nowhere to be is hard to find again.
          </Empty>
        ) : (
          <ul className="divide-y divide-slate-50">
            {plants.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">{p.name}</p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    <span className="font-mono">{p.code}</span>
                    {p.address && ` · ${p.address}`}
                    {' · '}{machines.filter((m) => m.plantId === p.id).length} machine(s)
                  </p>
                </div>
                {p.status === 'retired' && <Badge>Retired</Badge>}
                {mayWrite && p.status === 'active' && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (!window.confirm(
                        `Retire ${p.name}?\n\nMachines still on it have to be moved first.`,
                      )) return;
                      void act(() => api.post(`/equipment/plants/${p.id}/retire`));
                    }}
                  >
                    Retire
                  </Button>
                )}
                {mayWrite && p.status === 'retired' && (
                  <Button variant="ghost"
                    onClick={() => act(() => api.post(`/equipment/plants/${p.id}/reopen`))}>
                    Reopen
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}

function NewPlant({ onCancel, onDone, act }: {
  onCancel: () => void; onDone: () => void;
  act: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({ code: '', name: '', address: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Card title="New site">
      <form
        className="space-y-4 px-5 py-5"
        onSubmit={async (e) => {
          e.preventDefault();
          await act(() => api.post('/equipment/plants', {
            code: form.code.trim(),
            name: form.name.trim(),
            ...(form.address.trim() ? { address: form.address.trim() } : {}),
          }));
          onDone();
        }}
      >
        <div className="grid grid-cols-3 gap-4">
          <Field label="Name" required placeholder="Northern yard" value={form.name} onChange={set('name')} />
          <Field label="Code" required placeholder="NORTH" value={form.code} onChange={set('code')} />
          <Field label="Address" placeholder="Optional" value={form.address} onChange={set('address')} />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="submit">Add site</Button>
        </div>
      </form>
    </Card>
  );
}

function NewMachine({ plants, classes, onCancel, onDone, act }: {
  plants: Plant[]; classes: EquipmentClass[];
  onCancel: () => void; onDone: () => void;
  act: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    code: '', name: '', manufacturer: '', modelNumber: '', serialNumber: '',
    plantId: plants[0]?.id ?? '', equipmentClassSlug: '',
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Card
      title="New machine"
      note="The code is half of this machine's identity and cannot be changed later. It only has to be unique inside your account."
    >
      <form
        className="space-y-4 px-5 py-5"
        onSubmit={async (e) => {
          e.preventDefault();
          await act(() => api.post('/equipment', {
            code: form.code.trim(),
            name: form.name.trim(),
            ...(form.manufacturer.trim() ? { manufacturer: form.manufacturer.trim() } : {}),
            ...(form.modelNumber.trim() ? { modelNumber: form.modelNumber.trim() } : {}),
            ...(form.serialNumber.trim() ? { serialNumber: form.serialNumber.trim() } : {}),
            ...(form.plantId ? { plantId: form.plantId } : {}),
            ...(form.equipmentClassSlug ? { equipmentClassSlug: form.equipmentClassSlug } : {}),
          }));
          onDone();
        }}
      >
        <div className="grid grid-cols-3 gap-4">
          <Field label="Name" required placeholder="Generator 1" value={form.name} onChange={set('name')} />
          <Field label="Code" required placeholder="DG-07" value={form.code} onChange={set('code')} />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-700">Site</span>
            <select
              value={form.plantId}
              onChange={(e) => setForm((f) => ({ ...f, plantId: e.target.value }))}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none
                         focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
            >
              <option value="">Off site</option>
              {plants.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Manufacturer" placeholder="Optional" value={form.manufacturer} onChange={set('manufacturer')} />
          <Field label="Model" placeholder="Optional" value={form.modelNumber} onChange={set('modelNumber')} />
          <Field label="Serial number" placeholder="Optional" value={form.serialNumber} onChange={set('serialNumber')} />
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-700">Equipment class</span>
          <select
            value={form.equipmentClassSlug}
            onChange={(e) => setForm((f) => ({ ...f, equipmentClassSlug: e.target.value }))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none
                       focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
          >
            <option value="">Not classified yet</option>
            {classes.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>
          <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">
            {classes.length === 0
              ? 'Your account has no classes yet. Until it does, nothing can score this machine.'
              : 'Decides what scores this machine and which alert rules watch it. A machine left unclassified is owned and unwatched, which looks the same as fine.'}
          </span>
        </label>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="submit">Add machine</Button>
        </div>
      </form>
    </Card>
  );
}
