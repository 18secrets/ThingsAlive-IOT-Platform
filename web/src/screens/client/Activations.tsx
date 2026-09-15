import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuthed } from '../../lib/session';
import { explainBlocker } from '../../lib/types';
import type {
  Activation, Equipment as Machine, Recommendation,
} from '../../lib/types';
import { Page } from '../../shell/Shell';
import { Badge, Button, Card, Empty, Problem } from '../../shell/ui';

/**
 * What is actually running on each machine, and what is stopping the rest.
 *
 * This is the step that makes a grant mean something. An entitlement copies scenarios
 * into the account; nothing scores anything until somebody turns one on for a
 * particular machine, because Things Alive cannot know which of a customer's
 * generators is worth watching for coolant and which is a standby that runs twice a
 * year.
 *
 * The second half matters more on day one. A machine usually cannot run most of what
 * it has been granted yet — no logger fitted, a signal not mapped, not enough history —
 * and the platform knows precisely which. Every blocker here is a reason code with its
 * specifics rather than a sentence, so the screen can say "fit a sensor for
 * coolant_temp_c" instead of "not enough data", which gives an operator nothing to do.
 */
export function Activations() {
  const { can } = useAuthed();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [activations, setActivations] = useState<Activation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const mayActivate = can['scenario.activate'];

  const load = useCallback(async () => {
    setProblem(null);
    try {
      const [m, a] = await Promise.all([
        api.get<Machine[]>('/equipment'),
        api.get<Activation[]>('/activations'),
      ]);
      setMachines(m); setActivations(a);
    } catch (err) {
      setMachines([]);
      setProblem(err instanceof ApiError ? err.message : 'Could not load activations.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const current = useMemo(
    () => (machines ?? []).find((m) => m.externalId === selected) ?? (machines ?? [])[0] ?? null,
    [machines, selected],
  );

  // Recommendations are per machine and cost a real query each, so they are fetched for
  // the one being looked at rather than for the whole fleet up front.
  useEffect(() => {
    if (!current) { setRecommendations(null); return; }
    let live = true;
    setRecommendations(null);
    (async () => {
      try {
        const res = await api.get<{ recommendations: Recommendation[] }>(
          `/catalog/equipment/${current.sourceSystem}/${current.externalId}/recommendations`);
        if (live) setRecommendations(res.recommendations);
      } catch {
        if (live) setRecommendations([]);
      }
    })();
    return () => { live = false; };
  }, [current?.sourceSystem, current?.externalId]);

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key); setProblem(null);
    try { await run(); await load(); }
    catch (err) { setProblem(err instanceof ApiError ? err.message : 'That did not go through.'); }
    finally { setBusy(null); }
  };

  const mine = activations.filter((a) => a.externalId === current?.externalId);
  const running = mine.filter((a) => a.state === 'active');
  const notRunning = mine.filter((a) => a.state !== 'active');

  const transition = (verb: 'activate' | 'pause' | 'resume' | 'deactivate', a: Activation) => {
    const needsReason = verb === 'pause' || verb === 'deactivate';
    let reason: string | null = null;
    if (needsReason) {
      reason = window.prompt(
        verb === 'pause'
          ? 'Pausing this. Why, and what would bring it back?'
          : 'Turning this off for good. Why?',
      );
      if (!reason?.trim()) return;
    }
    void act(a.id, () => api.post(`/activations/${verb}`, {
      sourceSystem: a.sourceSystem,
      externalId: a.externalId,
      clientScenarioSlug: a.clientScenarioSlug,
      ...(reason ? { reason: reason.trim() } : {}),
    }));
  };

  return (
    <Page
      title="Activations"
      lede="What each machine is being scored for. A granted scenario does nothing until you turn it on for a particular machine — we cannot know which of your generators is worth watching and which is a standby that runs twice a year."
    >
      {problem && <Problem onRetry={load}>{problem}</Problem>}

      <div className="grid grid-cols-[260px_1fr] gap-5">
        <Card title="Machines">
          {machines === null ? (
            <Empty title="Loading…" />
          ) : machines.length === 0 ? (
            <Empty title="No machines yet">
              Add them on Equipment first. There is nothing to activate a scenario against.
            </Empty>
          ) : (
            <ul className="divide-y divide-slate-50">
              {machines.map((m) => {
                const on = activations.filter(
                  (a) => a.externalId === m.externalId && a.state === 'active').length;
                return (
                  <li key={m.externalId}>
                    <button
                      onClick={() => setSelected(m.externalId)}
                      className={`w-full px-5 py-3 text-left transition ${
                        current?.externalId === m.externalId ? 'bg-slate-100' : 'hover:bg-slate-50'
                      }`}
                    >
                      <span className="block text-sm font-medium text-slate-900">
                        {m.name ?? m.externalId}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-slate-500">
                        {on > 0
                          ? `${on} scenario${on === 1 ? '' : 's'} running`
                          : <span className="text-warn-700">nothing running</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {current ? (
          <div className="space-y-5">
            <Card
              title={`Running on ${current.name ?? current.externalId}`}
              note={running.length === 0
                ? 'Nothing is being scored on this machine. It is in the register and quiet.'
                : undefined}
            >
              {running.length === 0 ? (
                <Empty title="Nothing activated">
                  Turning a scenario on is what starts the scoring. Until then this machine
                  is owned, possibly monitored, and not being reasoned about.
                </Empty>
              ) : (
                <ul className="divide-y divide-slate-50">
                  {running.map((a) => (
                    <li key={a.id} className="flex items-start gap-3 px-5 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-900">{a.clientScenarioSlug}</p>
                        <p className="mt-0.5 text-[11px] text-slate-500">
                          on since {a.activatedAt ? new Date(a.activatedAt).toLocaleDateString() : '—'}
                          {a.activatedBy && ` · ${a.activatedBy}`}
                          {a.lastEvaluatedAt
                            ? ` · last scored ${new Date(a.lastEvaluatedAt).toLocaleDateString()}`
                            : ' · never scored'}
                        </p>
                        {a.blockersAtActivation.length > 0 && (
                          <p className="mt-1 text-[11px] leading-relaxed text-warn-700">
                            Turned on with {a.blockersAtActivation.length} thing
                            {a.blockersAtActivation.length === 1 ? '' : 's'} unresolved:{' '}
                            {a.blockersAtActivation.map(explainBlocker).join('; ')}. It runs, but
                            it may score nothing until those are dealt with.
                          </p>
                        )}
                        <Parameters activation={a} />
                      </div>
                      {mayActivate && (
                        <div className="flex shrink-0 gap-1.5">
                          <Button variant="ghost" disabled={busy === a.id}
                            onClick={() => transition('pause', a)}>Pause</Button>
                          <Button variant="danger" disabled={busy === a.id}
                            onClick={() => transition('deactivate', a)}>Turn off</Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {notRunning.length > 0 && (
              <Card title="Paused, proposed and turned off">
                <ul className="divide-y divide-slate-50">
                  {notRunning.map((a) => (
                    <li key={a.id} className="flex items-start gap-3 px-5 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                          {a.clientScenarioSlug}
                          <StateBadge state={a.state} />
                        </p>
                        {a.stateReason && (
                          <p className="mt-0.5 text-[11px] text-slate-500">
                            “{a.stateReason}” — {a.stateChangedBy}
                          </p>
                        )}
                      </div>
                      {mayActivate && (
                        <Button disabled={busy === a.id}
                          onClick={() => transition(a.state === 'paused' ? 'resume' : 'activate', a)}>
                          {a.state === 'paused' ? 'Resume' : 'Activate'}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <Card
              title="What else this machine could run"
              note="Every answer here comes from recorded facts — the class, the sensor map, the age of the oldest reading. Nothing is inferred, because a recommendation engine that guesses produces a list that is confidently wrong."
            >
              {recommendations === null ? (
                <Empty title="Working it out…" />
              ) : recommendations.length === 0 ? (
                <Empty title="Nothing to suggest">
                  This machine's class carries no scenarios your account holds.
                </Empty>
              ) : (
                <ul className="divide-y divide-slate-50">
                  {recommendations
                    .filter((r) => !mine.some((a) => a.clientScenarioSlug === r.scenarioSlug && a.state === 'active'))
                    .map((r) => (
                      <li key={r.scenarioSlug} className="flex items-start gap-3 px-5 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                            {r.name}
                            <BucketBadge bucket={r.bucket} />
                          </p>
                          {r.blockedBy.length > 0 ? (
                            <ul className="mt-1 space-y-0.5">
                              {r.blockedBy.map((b, i) => (
                                <li key={i} className="text-[11px] leading-relaxed text-slate-600">
                                  · {explainBlocker(b)}
                                </li>
                              ))}
                              {r.estimatedReadyDate && (
                                <li className="text-[11px] text-slate-500">
                                  · ready around {new Date(r.estimatedReadyDate).toLocaleDateString()},
                                  if nothing else is missing
                                </li>
                              )}
                            </ul>
                          ) : (
                            <p className="mt-0.5 text-[11px] text-slate-500">
                              Ready. Nothing is stopping this one.
                            </p>
                          )}
                        </div>
                        {mayActivate && (
                          <Button
                            variant={r.bucket === 'availableNow' ? 'primary' : 'ghost'}
                            disabled={busy === r.scenarioSlug}
                            onClick={() => {
                              if (r.blockedBy.length > 0 && !window.confirm(
                                `Turn on ${r.name} anyway?\n\n`
                                + r.blockedBy.map(explainBlocker).join('\n')
                                + '\n\nIt will run, and it may score nothing until these are '
                                + 'dealt with. What was unresolved is recorded against the '
                                + 'activation so nobody has to guess later.',
                              )) return;
                              void act(r.scenarioSlug, () => api.post('/activations/activate', {
                                sourceSystem: current.sourceSystem,
                                externalId: current.externalId,
                                clientScenarioSlug: r.scenarioSlug,
                              }));
                            }}
                          >
                            {r.blockedBy.length > 0 ? 'Turn on anyway' : 'Turn on'}
                          </Button>
                        )}
                      </li>
                    ))}
                </ul>
              )}
            </Card>
          </div>
        ) : (
          <Card><Empty title="No machine selected" /></Card>
        )}
      </div>
    </Page>
  );
}

function StateBadge({ state }: { state: string }) {
  if (state === 'paused') return <Badge tone="warn">paused</Badge>;
  if (state === 'proposed') return <Badge>proposed</Badge>;
  return <Badge>turned off</Badge>;
}

function BucketBadge({ bucket }: { bucket: string }) {
  if (bucket === 'availableNow') return <Badge tone="ok">ready</Badge>;
  if (bucket === 'availableLater') return <Badge tone="warn">not yet</Badge>;
  return <Badge>not for this machine</Badge>;
}

/**
 * Which settings were tuned here and which are the shipped defaults.
 *
 * Only the overrides are shown. A list of every parameter with most of them at their
 * default buries the one somebody changed, and the one somebody changed is the only
 * reason anybody opens this.
 */
function Parameters({ activation }: { activation: Activation }) {
  const overrides = activation.resolvedParameters.filter((p) => p.source === 'asset-override');
  if (overrides.length === 0) return null;
  return (
    <p className="mt-1 text-[11px] text-slate-500">
      tuned here: {overrides.map((p) => `${p.key} = ${String(p.value)}`).join(', ')}
    </p>
  );
}
