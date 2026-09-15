import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import {
  draftOf, latestPerSlug,
} from '../../lib/types';
import type {
  AlertTemplate, AlertTrigger, CatalogStatus, CausalChain, EquipmentClass, Scenario, Severity,
} from '../../lib/types';
import { Page } from '../../shell/Shell';
import { Badge, Button, Card, Empty, Field, Problem } from '../../shell/ui';

/**
 * What Things Alive sells, as it is written down.
 *
 * Four kinds of content hang off one equipment class — the signals it expects, the
 * scenarios that score it, the alert rules that ship with it, and the causal chain that
 * explains it — and all four version and publish the same way. A grant copies all four
 * into an account at once, so authoring them anywhere but on one screen would mean
 * discovering at grant time that three of the four were ready.
 *
 * Drafts are visible here and nowhere else. The client-facing read returns published
 * rows only, and must: a tenant that could see a draft could activate something nobody
 * has finished writing.
 */
export function Catalog() {
  const [classes, setClasses] = useState<EquipmentClass[] | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [templates, setTemplates] = useState<AlertTemplate[]>([]);
  const [chains, setChains] = useState<CausalChain[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setProblem(null);
    try {
      const [c, s, t, ch] = await Promise.all([
        api.get<EquipmentClass[]>('/catalog/authoring/equipment-classes'),
        api.get<Scenario[]>('/catalog/authoring/scenarios'),
        api.get<AlertTemplate[]>('/catalog/authoring/alert-templates'),
        api.get<CausalChain[]>('/intelligence/authoring/chains'),
      ]);
      setClasses(c); setScenarios(s); setTemplates(t); setChains(ch);
    } catch (err) {
      setClasses([]);
      setProblem(err instanceof ApiError ? err.message : 'Could not load the catalog.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const latestClasses = useMemo(() => latestPerSlug(classes ?? []), [classes]);

  // The selection follows the data rather than the other way round: a class that has
  // just been created should open, and one nobody selected should not leave the panel
  // empty when there is something to show.
  const current = latestClasses.find((c) => c.slug === selected) ?? latestClasses[0] ?? null;

  const act = async (run: () => Promise<unknown>) => {
    setProblem(null);
    try { await run(); await load(); }
    catch (err) { setProblem(err instanceof ApiError ? err.message : 'That did not go through.'); }
  };

  return (
    <Page
      title="Catalog"
      lede="Equipment classes and everything Things Alive knows about them. Granting a class copies all of it — scenarios, alert rules and the causal chain — into a customer's account in one go, which is why they are authored together."
      right={<Button onClick={() => setCreating(true)}>New class</Button>}
    >
      {problem && <Problem onRetry={load}>{problem}</Problem>}

      {creating && (
        <NewClass onCancel={() => setCreating(false)} onCreated={(slug) => {
          setCreating(false); setSelected(slug); void load();
        }} />
      )}

      <div className="grid grid-cols-[260px_1fr] gap-5">
        <Card title="Classes">
          {classes === null ? (
            <Empty title="Loading…" />
          ) : latestClasses.length === 0 ? (
            <Empty title="Nothing in the catalog">
              A class is the root of everything else. Create one, declare the signals it
              expects, then hang scenarios and alert rules off it.
            </Empty>
          ) : (
            <ul className="divide-y divide-slate-50">
              {latestClasses.map((c) => (
                <li key={c.slug}>
                  <button
                    onClick={() => setSelected(c.slug)}
                    className={`w-full px-5 py-3 text-left transition ${
                      current?.slug === c.slug ? 'bg-brand-50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <span className="block text-sm font-medium text-slate-900">{c.name}</span>
                    <span className="mt-1 flex items-center gap-1.5">
                      <StatusBadge status={c.status} />
                      <span className="text-[11px] text-slate-400">v{c.version}</span>
                      {draftOf(classes, c.slug) && c.status !== 'draft' && (
                        <span className="text-[11px] font-medium text-warn-700">draft open</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {current ? (
          <ClassDetail
            klass={current}
            allVersions={(classes ?? []).filter((c) => c.slug === current.slug)}
            scenarios={latestPerSlug(scenarios.filter((s) => s.equipmentClassSlug === current.slug))}
            templates={latestPerSlug(templates.filter((t) => t.equipmentClassSlug === current.slug))}
            chains={latestPerSlug(chains.filter((c) => c.equipmentClassSlug === current.slug))}
            act={act}
          />
        ) : (
          <Card><Empty title="No class selected" /></Card>
        )}
      </div>
    </Page>
  );
}

function StatusBadge({ status }: { status: CatalogStatus }) {
  if (status === 'published') return <Badge tone="ok">Published</Badge>;
  if (status === 'retired') return <Badge>Retired</Badge>;
  return <Badge tone="warn">Draft</Badge>;
}

function ClassDetail({ klass, allVersions, scenarios, templates, chains, act }: {
  klass: EquipmentClass;
  allVersions: EquipmentClass[];
  scenarios: Scenario[];
  templates: AlertTemplate[];
  chains: CausalChain[];
  act: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const [addingScenario, setAddingScenario] = useState(false);
  const [addingTemplate, setAddingTemplate] = useState(false);
  const declared = klass.expectedSignals?.map((s) => s.signal) ?? [];
  const openDraft = allVersions.find((v) => v.status === 'draft');

  return (
    <div className="space-y-5">
      <Card
        title={klass.name}
        note={klass.description ?? undefined}
        right={
          <div className="flex items-center gap-2">
            {openDraft && (
              <Button onClick={() => act(() =>
                api.post(`/catalog/equipment-classes/${klass.slug}/publish`))}>
                Publish v{openDraft.version}
              </Button>
            )}
            {klass.status === 'published' && (
              <Button variant="ghost" onClick={() => {
                if (!window.confirm(
                  `Retire ${klass.name}?\n\nIt stops being offered. Accounts that already `
                  + 'have a copy keep running it — retiring is not taking it away.',
                )) return;
                void act(() => api.post(`/catalog/equipment-classes/${klass.slug}/retire`));
              }}>Retire</Button>
            )}
          </div>
        }
      >
        <div className="grid grid-cols-3 gap-5 px-5 py-5 text-xs">
          <Fact label="Slug"><code className="font-mono">{klass.slug}</code></Fact>
          <Fact label="Category">{klass.category ?? '—'}</Fact>
          <Fact label="Service interval">
            {klass.serviceIntervalHours ? `${klass.serviceIntervalHours} h` : '—'}
          </Fact>
        </div>

        <div className="border-t border-slate-100 px-5 py-4">
          <p className="mb-2 text-xs font-semibold text-slate-700">Expected signals</p>
          {declared.length === 0 ? (
            <p className="text-xs leading-relaxed text-slate-500">
              None declared. A class with no signals cannot be published: every scenario on
              it would be permanently blocked, and the blocker would name signals the class
              never promised.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {klass.expectedSignals.map((s) => (
                <span key={s.signal} className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-700">
                  {s.signal}{s.unit ? <span className="text-slate-400"> {s.unit}</span> : null}
                  {s.required === false && <span className="text-slate-400"> · optional</span>}
                </span>
              ))}
            </div>
          )}
        </div>

        {allVersions.length > 1 && (
          <div className="border-t border-slate-100 px-5 py-3">
            <p className="text-[11px] leading-relaxed text-slate-500">
              Versions: {allVersions.sort((a, b) => b.version - a.version)
                .map((v) => `v${v.version} ${v.status}`).join(' · ')}.
              Editing a published version forks a new draft rather than changing it, because
              every client copy records the version it came from and a version edited in
              place makes that record a lie.
            </p>
          </div>
        )}
      </Card>

      <Card
        title="Scenarios"
        note="What the scorer runs. Each names the signals it needs, and a scenario requiring a signal the class does not declare is refused rather than left permanently blocked."
        right={<Button variant="ghost" onClick={() => setAddingScenario(true)}>Add scenario</Button>}
      >
        {addingScenario && (
          <NewScenario
            classSlug={klass.slug} declared={declared}
            onCancel={() => setAddingScenario(false)}
            onDone={() => { setAddingScenario(false); }}
            act={act}
          />
        )}
        {scenarios.length === 0 ? (
          <Empty title="No scenarios yet">
            A class with no scenarios grants a customer a description of a machine and
            nothing that scores it.
          </Empty>
        ) : (
          <ul className="divide-y divide-slate-50">
            {scenarios.map((s) => (
              <li key={s.slug} className="flex items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">{s.name}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-400">{s.slug} · v{s.version}</p>
                  {s.requiredSignals.length > 0 && (
                    <p className="mt-1 text-[11px] text-slate-500">
                      needs {s.requiredSignals.join(', ')}
                      {s.minimumHistoryDays > 0 && ` · ${s.minimumHistoryDays} days of history`}
                    </p>
                  )}
                </div>
                <StatusBadge status={s.status} />
                {s.status === 'draft' && (
                  <Button onClick={() => act(() => api.post(`/catalog/scenarios/${s.slug}/publish`))}>
                    Publish
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Alert templates"
        note="What Things Alive knows is worth being told about. Granting the class copies these in as the customer's own rules — they edit their copies, and nobody here can write them afterwards."
        right={<Button variant="ghost" onClick={() => setAddingTemplate(true)}>Add alert</Button>}
      >
        {addingTemplate && (
          <NewAlertTemplate
            classSlug={klass.slug} declared={declared}
            onCancel={() => setAddingTemplate(false)}
            onDone={() => { setAddingTemplate(false); }}
            act={act}
          />
        )}
        {templates.length === 0 ? (
          <Empty title="No alert templates yet">
            An account granted this class starts with an empty rules list, and has to
            already know what matters about this kind of machine. That knowledge is the
            product.
          </Empty>
        ) : (
          <ul className="divide-y divide-slate-50">
            {templates.map((t) => (
              <li key={t.slug} className="flex items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">{t.name}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-400">{t.slug} · v{t.version}</p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {describeTrigger(t)} · fires at {t.severity}
                    {t.enabledOnCopy
                      ? ' · ships switched on'
                      : ' · ships switched off, for somebody to turn on once they have looked'}
                  </p>
                </div>
                <StatusBadge status={t.status} />
                {t.status === 'draft' && (
                  <Button onClick={() => act(() => api.post(`/catalog/alert-templates/${t.slug}/publish`))}>
                    Publish
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Causal chain"
        note="The physics: what each stage should read given its drivers, and how far off that a fault is. It is why an alert can say which component the fault entered at rather than which number went high."
      >
        {chains.length === 0 ? (
          <Empty title="No chain for this class">
            Without one, a hot machine is a hot machine. With one, a machine 18 °C above
            what its load predicts is a fault, and the warm bearing downstream is explained
            rather than reported twice.
          </Empty>
        ) : (
          <ul className="divide-y divide-slate-50">
            {chains.map((c) => (
              <li key={c.slug} className="px-5 py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900">{c.name}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-slate-400">{c.slug} · v{c.version}</p>
                  </div>
                  <StatusBadge status={c.status} />
                  {c.status === 'draft' && (
                    <Button onClick={() => act(() => api.post(`/intelligence/chains/${c.slug}/publish`))}>
                      Publish
                    </Button>
                  )}
                </div>
                {c.nodes.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {c.nodes.map((n, i) => (
                      <span key={n.signal} className="flex items-center gap-1.5">
                        {i > 0 && <span className="text-slate-300">→</span>}
                        <span className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-700">
                          {n.label ?? n.signal}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-0.5 font-medium text-slate-900">{children}</dd>
    </div>
  );
}

function describeTrigger(t: AlertTemplate): string {
  const p = t.params as Record<string, any>;
  switch (t.trigger) {
    case 'signal-threshold': {
      const bounds = [
        p.max != null ? `above ${p.max}` : null,
        p.min != null ? `below ${p.min}` : null,
      ].filter(Boolean).join(' or ');
      return `${p.signal} ${bounds}`;
    }
    case 'prediction-severity':
      return `a prediction reaching ${p.atLeast}${p.clientScenarioSlug ? ` on ${p.clientScenarioSlug}` : ''}`;
    case 'no-telemetry':
      return 'a shift that produced no readings at all';
    case 'fuel-loss':
      return 'fuel leaving a machine that was off and did not move';
    case 'chain-origin':
      return `a chain fault entering at ${p.stageSignal ?? 'any stage'}, at ${p.atLeast} or worse`;
    default:
      return t.trigger;
  }
}

function NewClass({ onCancel, onCreated }: { onCancel: () => void; onCreated: (slug: string) => void }) {
  const [form, setForm] = useState({ slug: '', name: '', category: '', signals: '' });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setProblem(null);
    try {
      // `signal unit` per line, unit optional. A form with one field per signal would be
      // slower for the only people who use this screen, who are typing from a datasheet.
      const expectedSignals = form.signals.split('\n').map((line) => line.trim()).filter(Boolean)
        .map((line) => {
          const [signal, unit] = line.split(/\s+/);
          return { signal, unit: unit ?? null, required: true };
        });
      await api.post('/catalog/equipment-classes', {
        slug: form.slug.trim(),
        name: form.name.trim(),
        ...(form.category.trim() ? { category: form.category.trim() } : {}),
        expectedSignals,
      });
      onCreated(form.slug.trim());
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not create that class.');
    } finally { setBusy(false); }
  }

  return (
    <Card title="New equipment class" note="Created as a draft. Nothing can be granted until it is published.">
      <form onSubmit={submit} className="space-y-4 px-5 py-5">
        <div className="grid grid-cols-3 gap-4">
          <Field label="Name" required placeholder="Diesel generator" value={form.name} onChange={set('name')} />
          <Field label="Slug" required placeholder="diesel-generator" value={form.slug} onChange={set('slug')}
            hint="Permanent. Client copies record it." />
          <Field label="Category" placeholder="power" value={form.category} onChange={set('category')} />
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-700">Expected signals</span>
          <textarea
            required rows={4} value={form.signals}
            onChange={(e) => setForm((f) => ({ ...f, signals: e.target.value }))}
            placeholder={'coolant_temp_c C\nload_percent %\noil_temp_c C'}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900
                       outline-none placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
          />
          <span className="mt-1 block text-[11px] text-slate-500">
            One per line, name then unit. Everything else on this class is checked against
            this list, so a typo here becomes a scenario nobody can publish.
          </span>
        </label>
        {problem && <Problem>{problem}</Problem>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create draft'}</Button>
        </div>
      </form>
    </Card>
  );
}

const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];

function NewScenario({ classSlug, declared, onCancel, onDone, act }: {
  classSlug: string; declared: string[];
  onCancel: () => void; onDone: () => void;
  act: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({ slug: '', name: '', severity: 'medium' as Severity, signals: [] as string[] });

  return (
    <form
      className="space-y-4 border-b border-slate-100 bg-slate-50/60 px-5 py-5"
      onSubmit={async (e) => {
        e.preventDefault();
        await act(() => api.post('/catalog/scenarios', {
          slug: form.slug.trim(),
          equipmentClassSlug: classSlug,
          name: form.name.trim(),
          severity: form.severity,
          requiredSignals: form.signals,
        }));
        onDone();
      }}
    >
      <div className="grid grid-cols-3 gap-4">
        <Field label="Name" required placeholder="Coolant over-temperature"
          value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <Field label="Slug" required placeholder="dg-coolant-overheat"
          value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} />
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-700">Severity</span>
          <select
            value={form.severity}
            onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value as Severity }))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none
                       focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
          >
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>

      <SignalPicker
        declared={declared} chosen={form.signals}
        onChange={(signals) => setForm((f) => ({ ...f, signals }))}
        note="Only signals this class declares. One it does not is refused, because the scorer cannot tell a typo from an absent sensor and the blocker would send somebody to fit one that is already there."
      />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit">Add as draft</Button>
      </div>
    </form>
  );
}

const TRIGGERS: { value: AlertTrigger; label: string; help: string }[] = [
  { value: 'signal-threshold', label: 'Signal threshold',
    help: 'A bound the manufacturer or Things Alive knows matters, independent of any model.' },
  { value: 'prediction-severity', label: 'Prediction severity',
    help: 'The scorer said something and nobody is watching the screen. The ordinary one.' },
  { value: 'no-telemetry', label: 'No telemetry',
    help: 'A shift ran and the machine said nothing. Silence is indistinguishable from "fine" unless somebody asks for it.' },
  { value: 'chain-origin', label: 'Chain origin',
    help: 'A stage off the curve its own drivers predict — which a merely hard-working machine is not.' },
  { value: 'fuel-loss', label: 'Fuel loss',
    help: 'Fuel left a machine that was switched off and did not move. Needs no model and no history.' },
];

function NewAlertTemplate({ classSlug, declared, onCancel, onDone, act }: {
  classSlug: string; declared: string[];
  onCancel: () => void; onDone: () => void;
  act: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    slug: '', name: '', trigger: 'signal-threshold' as AlertTrigger,
    signal: declared[0] ?? '', max: '', min: '', atLeast: 'high' as Severity,
    severity: 'high' as Severity, enabledOnCopy: true,
  });
  const chosen = TRIGGERS.find((t) => t.value === form.trigger)!;

  function params(): Record<string, unknown> {
    switch (form.trigger) {
      case 'signal-threshold':
        return {
          signal: form.signal,
          ...(form.max.trim() ? { max: Number(form.max) } : {}),
          ...(form.min.trim() ? { min: Number(form.min) } : {}),
        };
      case 'prediction-severity':
        return { atLeast: form.atLeast };
      case 'chain-origin':
        return { atLeast: form.atLeast === 'critical' ? 'critical' : 'warning' };
      default:
        return {};
    }
  }

  return (
    <form
      className="space-y-4 border-b border-slate-100 bg-slate-50/60 px-5 py-5"
      onSubmit={async (e) => {
        e.preventDefault();
        await act(() => api.post('/catalog/alert-templates', {
          slug: form.slug.trim(),
          equipmentClassSlug: classSlug,
          name: form.name.trim(),
          trigger: form.trigger,
          params: params(),
          severity: form.severity,
          enabledOnCopy: form.enabledOnCopy,
        }));
        onDone();
      }}
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Name" required placeholder="Coolant running hot for the load"
          value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <Field label="Slug" required placeholder="dg-coolant-hot"
          value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} />
      </div>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-700">Trigger</span>
        <select
          value={form.trigger}
          onChange={(e) => setForm((f) => ({ ...f, trigger: e.target.value as AlertTrigger }))}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none
                     focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
        >
          {TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">{chosen.help}</span>
      </label>

      {form.trigger === 'signal-threshold' && (
        <div className="grid grid-cols-3 gap-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-700">Signal</span>
            <select
              value={form.signal}
              onChange={(e) => setForm((f) => ({ ...f, signal: e.target.value }))}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900
                         outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
            >
              {declared.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <Field label="Above" type="number" placeholder="103"
            value={form.max} onChange={(e) => setForm((f) => ({ ...f, max: e.target.value }))} />
          <Field label="Below" type="number" placeholder="—"
            value={form.min} onChange={(e) => setForm((f) => ({ ...f, min: e.target.value }))} />
        </div>
      )}

      {(form.trigger === 'prediction-severity' || form.trigger === 'chain-origin') && (
        <label className="block w-48">
          <span className="mb-1 block text-xs font-medium text-slate-700">Fires at or above</span>
          <select
            value={form.atLeast}
            onChange={(e) => setForm((f) => ({ ...f, atLeast: e.target.value as Severity }))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none
                       focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
          >
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      )}

      <div className="flex items-end gap-6">
        <label className="block w-48">
          <span className="mb-1 block text-xs font-medium text-slate-700">Severity when it fires</span>
          <select
            value={form.severity}
            onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value as Severity }))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none
                       focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
          >
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        <label className="flex items-start gap-2 pb-2">
          <input
            type="checkbox" checked={form.enabledOnCopy}
            onChange={(e) => setForm((f) => ({ ...f, enabledOnCopy: e.target.checked }))}
            className="mt-0.5"
          />
          <span className="text-xs leading-relaxed text-slate-600">
            <strong className="text-slate-900">Ships switched on.</strong> Leave this off for
            a rule that is noisy until somebody has looked at the fleet — a new customer
            whose first week is full of alerts learns that ours are noise.
          </span>
        </label>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit">Add as draft</Button>
      </div>
    </form>
  );
}

function SignalPicker({ declared, chosen, onChange, note }: {
  declared: string[]; chosen: string[]; onChange: (next: string[]) => void; note: string;
}) {
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-slate-700">Required signals</span>
      {declared.length === 0 ? (
        <p className="text-[11px] text-slate-500">This class declares no signals yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {declared.map((s) => {
            const on = chosen.includes(s);
            return (
              <button
                key={s} type="button"
                onClick={() => onChange(on ? chosen.filter((x) => x !== s) : [...chosen, s])}
                className={`rounded-md px-2 py-1 font-mono text-[11px] transition ${
                  on ? 'bg-brand-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {s}
              </button>
            );
          })}
        </div>
      )}
      <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">{note}</span>
    </div>
  );
}
