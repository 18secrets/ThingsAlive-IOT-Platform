import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuthed } from '../../lib/session';
import { originOf } from '../../lib/types';
import type { AlertEvent, AlertRule, Equipment as Machine } from '../../lib/types';
import { Page } from '../../shell/Shell';
import { Badge, Button, Card, Empty, Problem, Td, Th } from '../../shell/ui';

/**
 * What this account has asked to be told about, and what it has been told.
 *
 * Two halves that are easy to confuse and must not be. A **rule** is a standing request
 * from the customer — their judgement about what matters, which is not ours to guess.
 * An **event** is one occasion on which a rule was true. The rules are real today; the
 * events stay empty until scoring runs, which needs the legacy telemetry credentials.
 *
 * Most of the rules in a new account were not written here. They arrived with the
 * equipment class, carrying what Things Alive knows about that kind of machine, and the
 * moment they landed they became the customer's. This screen says which is which,
 * because "did we ship this?" and "is this still what we shipped?" are the two questions
 * support is asked and neither is answerable from a rule's name.
 */
export function Alerts() {
  const { can } = useAuthed();
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const mayAuthor = can['alert.author'];
  const mayWork = can['action.work'];

  const load = useCallback(async () => {
    setProblem(null);
    try {
      const [r, e, m] = await Promise.all([
        api.get<AlertRule[]>('/alerts/rules'),
        api.get<AlertEvent[]>('/alerts?state=open,acknowledged'),
        api.get<Machine[]>('/equipment').catch(() => []),
      ]);
      setRules(r); setEvents(e); setMachines(m);
    } catch (err) {
      setRules([]);
      setProblem(err instanceof ApiError ? err.message : 'Could not load your alerts.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key); setProblem(null);
    try { await run(); await load(); }
    catch (err) { setProblem(err instanceof ApiError ? err.message : 'That did not go through.'); }
    finally { setBusy(null); }
  };

  const machineName = (externalId: string) =>
    machines.find((m) => m.externalId === externalId)?.name ?? externalId;

  const stale = (rules ?? []).filter((r) => r.provenance.newerTemplateAvailable);
  const off = (rules ?? []).filter((r) => !r.enabled);

  return (
    <Page
      title="Alerts"
      lede="The rules this account watches by, and what they have raised. A rule is your standing request to be told when something is true; most of these arrived with your equipment classes and are now yours to change."
    >
      {problem && <Problem onRetry={load}>{problem}</Problem>}

      {stale.length > 0 && (
        <Card title="Newer versions are available">
          <p className="px-5 py-4 text-xs leading-relaxed text-slate-600">
            Things Alive has published a newer version of {stale.length} rule
            {stale.length === 1 ? '' : 's'} you hold a copy of. Nothing has changed on your
            side and nothing will unless you adopt it — and adopting replaces your copy,
            discarding any edits you have made to it.
          </p>
        </Card>
      )}

      <Card
        title="Raised"
        note="Open and acknowledged alerts. Resolved ones drop off this list; the rule that raised each is named so an alert nobody wants can be switched off rather than ignored."
      >
        {rules === null ? (
          <Empty title="Loading…" />
        ) : events.length === 0 ? (
          <Empty title="Nothing raised">
            Either nothing has been true, or nothing has been scored yet. Scoring runs when
            a shift ends and needs telemetry; until the platform is reading from your
            loggers, this list stays empty whatever your rules say.
          </Empty>
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-100">
              <tr>
                <Th>Machine</Th><Th>What happened</Th><Th>Rule</Th><Th>When</Th><Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {events.map((e) => (
                <tr key={e.id}>
                  <Td className="font-medium text-slate-900">{machineName(e.externalId)}</Td>
                  <Td>
                    <SeverityBadge severity={e.severity} />
                    <span className="ml-2">{e.summary}</span>
                    {e.state === 'acknowledged' && (
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        seen by {e.acknowledgedBy} — still open
                      </p>
                    )}
                  </Td>
                  <Td className="text-xs text-slate-500">{e.ruleName}</Td>
                  <Td className="text-xs text-slate-500">{new Date(e.firedAt).toLocaleString()}</Td>
                  <Td className="text-right">
                    {mayWork && (
                      <div className="flex justify-end gap-1.5">
                        {e.state === 'open' && (
                          <Button variant="ghost" disabled={busy === e.id}
                            onClick={() => act(e.id, () => api.post(`/alerts/${e.id}/acknowledge`))}>
                            I have seen it
                          </Button>
                        )}
                        <Button disabled={busy === e.id} onClick={() => {
                          const note = window.prompt('What was found, and what was done?');
                          if (!note?.trim()) return;
                          void act(e.id, () => api.post(`/alerts/${e.id}/resolve`, { note: note.trim() }));
                        }}>
                          Resolve
                        </Button>
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="Rules"
        note={off.length > 0
          ? `${off.length} of these ${off.length === 1 ? 'is' : 'are'} switched off. A rule that is off raised nothing and explains nothing, which is different from a rule that was never true.`
          : undefined}
      >
        {rules === null ? (
          <Empty title="Loading…" />
        ) : rules.length === 0 ? (
          <Empty title="No rules yet">
            Rules normally arrive with an equipment class — that is where what Things Alive
            knows about a kind of machine lives. An account with none has either been
            granted nothing yet, or holds classes that ship no rules.
          </Empty>
        ) : (
          <ul className="divide-y divide-slate-50">
            {rules.map((r) => (
              <li key={r.id} className="flex items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                    {r.name}
                    <OriginBadge rule={r} />
                    {!r.enabled && <span className="text-[11px] font-normal text-slate-400">off</span>}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {describeScope(r)} · {describeTrigger(r)} · raises {r.severity}
                  </p>
                  {r.provenance.newerTemplateAvailable && (
                    <p className="mt-1 text-[11px] leading-relaxed text-warn-700">
                      Version {r.provenance.newerTemplateVersion} has been published; you
                      have v{r.provenance.templateVersion}.
                      {!r.provenance.unchangedSinceCopy && ' Adopting it would discard your edits.'}
                    </p>
                  )}
                </div>
                {mayAuthor && (
                  <Button
                    variant={r.enabled ? 'ghost' : 'primary'}
                    disabled={busy === r.id}
                    onClick={() => act(r.id, () =>
                      api.post(`/alerts/rules/${r.id}/${r.enabled ? 'disable' : 'enable'}`))}
                  >
                    {r.enabled ? 'Switch off' : 'Switch on'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Where these rules came from">
        <div className="space-y-3 px-5 py-5 text-xs leading-relaxed text-slate-600">
          <p>
            <strong className="text-slate-900">From template.</strong> Shipped with an
            equipment class and untouched since. It is what Things Alive knows about that
            kind of machine — a diesel generator's coolant is interesting at 103 °C, well
            before the 110 °C alarm the manufacturer stamped on it.
          </p>
          <p>
            <strong className="text-slate-900">Edited.</strong> Shipped, and then changed
            here. The copy is yours and nobody at Things Alive can write it, which is
            exactly why this label exists: it is the only way to tell what is running from
            what was shipped.
          </p>
          <p>
            <strong className="text-slate-900">Yours.</strong> Written in this account.
            Things Alive has no template for it and no opinion about it.
          </p>
        </div>
      </Card>
    </Page>
  );
}

function OriginBadge({ rule }: { rule: AlertRule }) {
  const origin = originOf(rule.provenance);
  if (origin === 'yours') return <Badge>yours</Badge>;
  if (origin === 'edited') return <Badge tone="warn">edited</Badge>;
  return <Badge tone="ok">from template</Badge>;
}

function SeverityBadge({ severity }: { severity: string }) {
  if (severity === 'critical') return <Badge tone="crit">critical</Badge>;
  if (severity === 'high') return <Badge tone="warn">high</Badge>;
  return <Badge>{severity}</Badge>;
}

function describeScope(r: AlertRule): string {
  switch (r.appliesTo) {
    case 'equipment-class': return `every ${r.equipmentClassSlug}`;
    case 'equipment': return r.externalId ?? 'one machine';
    case 'plant': return 'one site';
    default: return 'every machine';
  }
}

function describeTrigger(r: AlertRule): string {
  const p = r.params as Record<string, any>;
  switch (r.trigger) {
    case 'signal-threshold': {
      const bounds = [
        p.max != null ? `above ${p.max}` : null,
        p.min != null ? `below ${p.min}` : null,
      ].filter(Boolean).join(' or ');
      return `${p.signal} ${bounds}`;
    }
    case 'prediction-severity':
      return `a prediction reaching ${p.atLeast}`;
    case 'no-telemetry':
      return 'a shift with no readings at all';
    case 'fuel-loss':
      return 'fuel leaving a machine that was off and did not move';
    case 'chain-origin':
      return `a fault entering at ${p.stageSignal ?? 'any stage'}`;
    default:
      return r.trigger;
  }
}
