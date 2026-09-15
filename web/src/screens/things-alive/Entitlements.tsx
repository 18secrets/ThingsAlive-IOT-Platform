import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { Account, Entitlement, EquipmentClass } from '../../lib/types';
import { Page } from '../../shell/Shell';
import { Card, Empty, Problem, Td, Th } from '../../shell/ui';

/**
 * The commercial boundary, as a grid.
 *
 * A grant is not a flag. It copies the class, its scenarios and its causal chain into
 * the account as the client's own rows — which is why the cell below says "granted"
 * rather than "on", and why revoking does not take the copies away. The matrix exists
 * because the question people actually ask is "who has what", and a per-account list
 * answers it one account at a time.
 */
export function Entitlements() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [classes, setClasses] = useState<EquipmentClass[] | null>(null);
  const [grants, setGrants] = useState<Entitlement[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busyCell, setBusyCell] = useState<string | null>(null);

  const load = useCallback(async () => {
    setProblem(null);
    try {
      const [a, c, g] = await Promise.all([
        api.get<Account[]>('/accounts'),
        api.get<EquipmentClass[]>('/catalog/equipment-classes'),
        api.get<Entitlement[]>('/catalog/entitlements'),
      ]);
      setAccounts(a); setClasses(c); setGrants(g);
    } catch (err) {
      setAccounts([]); setClasses([]); setGrants([]);
      setProblem(err instanceof ApiError ? err.message : 'Could not load entitlements.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * The live grant for a cell, if there is one. A revoked row stays in the table —
   * revoked is not deleted — so "is this granted" is "is there a row with no
   * revokedAt", not "is there a row".
   */
  const live = useMemo(() => {
    const map = new Map<string, Entitlement>();
    for (const g of grants ?? []) {
      if (!g.revokedAt) map.set(`${g.tenantId}::${g.equipmentClassSlug}`, g);
    }
    return map;
  }, [grants]);

  async function toggle(account: Account, klass: EquipmentClass) {
    const key = `${account.tenantId}::${klass.slug}`;
    const existing = live.get(key);
    setBusyCell(key);
    setProblem(null);
    try {
      if (existing) {
        const ok = window.confirm(
          `Revoke ${klass.name} from ${account.name}?\n\n`
          + 'Their copies are not deleted and their machines keep running. They stop '
          + 'receiving updates to the template, and cannot activate anything new from it.',
        );
        if (!ok) return;
        await api.post(`/catalog/entitlements/${existing.id}/revoke`);
      } else {
        await api.post('/catalog/entitlements', {
          tenantId: account.tenantId,
          equipmentClassSlug: klass.slug,
        });
      }
      await load();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'That grant did not go through.');
    } finally {
      setBusyCell(null);
    }
  }

  const loading = accounts === null || classes === null || grants === null;

  return (
    <Page
      title="Entitlements"
      lede="What each account has bought. Granting a class copies it — with its scenarios and its causal chain — into that account as their own rows, which is why they can then edit their copies and Things Alive cannot."
    >
      {problem && <Problem onRetry={load}>{problem}</Problem>}

      <Card
        title="Grants"
        note="Only published classes can be granted: a client cannot be given a copy of something that does not exist yet."
      >
        {loading ? (
          <Empty title="Loading…" />
        ) : accounts.length === 0 ? (
          <Empty title="No accounts to grant to">
            Provision an account first. Entitlements are the second step, and the one
            that turns an empty account into a working one.
          </Empty>
        ) : classes.length === 0 ? (
          <Empty title="No published classes">
            Classes are granted, not drafted here. Author one in the Catalog and publish
            it — a draft has nothing to copy.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-100">
                <tr>
                  <Th className="sticky left-0 bg-white">Account</Th>
                  {classes.map((c) => (
                    <Th key={c.slug} className="whitespace-nowrap">{c.name}</Th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {accounts.map((a) => (
                  <tr key={a.tenantId}>
                    <Td className="sticky left-0 bg-white font-medium text-slate-900">
                      {a.name}
                      {a.status === 'suspended' && (
                        <span className="ml-2 text-[11px] font-normal text-slate-400">suspended</span>
                      )}
                    </Td>
                    {classes.map((c) => {
                      const key = `${a.tenantId}::${c.slug}`;
                      const granted = live.get(key);
                      return (
                        <Td key={c.slug}>
                          <GrantCell
                            granted={Boolean(granted)}
                            grantedOn={granted?.grantedAt}
                            busy={busyCell === key}
                            onClick={() => toggle(a, c)}
                          />
                        </Td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="What a grant actually does">
        <div className="space-y-3 px-5 py-5 text-xs leading-relaxed text-slate-600">
          <p>
            <strong className="text-slate-900">It copies.</strong> The class, its scenarios
            and its causal chain are written into the account as their own rows, recording
            the template version they came from. The client edits their copies; nobody at
            Things Alive can write them.
          </p>
          <p>
            <strong className="text-slate-900">Revoking keeps the copies.</strong> The
            entitlement row stays with a revocation date — revoked is not deleted — and the
            account's machines keep running on what they already have. What stops is
            activating anything new from that class, and receiving template updates.
          </p>
          <p>
            <strong className="text-slate-900">Publishing a new template changes nothing
            on its own.</strong> An existing copy reports that a newer version exists;
            adopting it is the client's decision, and it discards their local edits.
          </p>
        </div>
      </Card>
    </Page>
  );
}

function GrantCell({ granted, grantedOn, busy, onClick }: {
  granted: boolean; grantedOn?: string; busy: boolean; onClick: () => void;
}) {
  if (busy) return <span className="text-[11px] text-slate-400">working…</span>;

  // A granted cell says "Revoke" on hover rather than turning red under the same word.
  // Colour alone cannot tell "this is granted" apart from "clicking this will ungrant
  // it", and those are opposite meanings on one control.
  if (granted) {
    return (
      <button
        onClick={onClick}
        title={grantedOn ? `Granted ${new Date(grantedOn).toLocaleDateString()}` : 'Granted'}
        className="group w-full rounded-lg border border-ok-600/25 bg-ok-50 px-2.5 py-1.5 text-[11px]
                   font-semibold text-ok-600 transition hover:border-crit-700/30 hover:bg-crit-50
                   hover:text-crit-700"
      >
        <span className="group-hover:hidden">Granted</span>
        <span className="hidden group-hover:inline">Revoke</span>
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      title="Not granted"
      className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px]
                 font-semibold text-slate-400 transition hover:border-brand-500 hover:text-brand-600"
    >
      Grant
    </button>
  );
}
