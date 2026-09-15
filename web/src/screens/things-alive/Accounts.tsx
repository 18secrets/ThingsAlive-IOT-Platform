import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { Account, Provisioned } from '../../lib/types';
import { Page } from '../../shell/Shell';
import { Badge, Button, Card, Empty, Field, Problem, Td, Th } from '../../shell/ui';

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Provisioned | null>(null);

  const load = useCallback(async () => {
    setProblem(null);
    try {
      setAccounts(await api.get<Account[]>('/accounts'));
    } catch (err) {
      setAccounts([]);
      setProblem(err instanceof ApiError ? err.message : 'Could not load accounts.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <Page
      title="Accounts"
      lede="Every customer Things Alive has provisioned. Creating one stands up the account, copies the role templates into it and seeds its first administrator — in a single transaction, so there is no state where an account exists with nobody able to sign in to it."
      right={<Button onClick={() => { setCreated(null); setCreating(true); }}>New account</Button>}
    >
      {problem && <Problem onRetry={load}>{problem}</Problem>}

      {created && <InvitationHandover result={created} onDone={() => setCreated(null)} />}

      {creating && (
        <NewAccount
          onCancel={() => setCreating(false)}
          onCreated={(result) => { setCreating(false); setCreated(result); void load(); }}
        />
      )}

      <Card title="Provisioned accounts">
        {accounts === null ? (
          <Empty title="Loading…" />
        ) : accounts.length === 0 ? (
          <Empty title="No accounts yet">
            Nothing here is seeded. The first account is created above, and everything a
            client eventually sees begins with a grant made against it.
          </Empty>
        ) : (
          <table className="w-full">
            <thead className="border-b border-slate-100">
              <tr>
                <Th>Account</Th><Th>Tenant</Th><Th>Plan</Th><Th>Region</Th><Th>Status</Th><Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {accounts.map((a) => <Row key={a.tenantId} account={a} onChanged={load} />)}
            </tbody>
          </table>
        )}
      </Card>
    </Page>
  );
}

function Row({ account, onChanged }: { account: Account; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const suspended = account.status === 'suspended';

  async function toggle() {
    if (suspended) {
      setBusy(true);
      try { await api.post(`/accounts/${account.tenantId}/reinstate`); onChanged(); }
      finally { setBusy(false); }
      return;
    }
    // The platform requires a reason and says why: somebody will ask their account
    // manager why their fleet went dark, and the answer should already be written down.
    const reason = window.prompt(`Suspend ${account.name}? Every sign-in stops immediately.\n\nReason:`);
    if (!reason?.trim()) return;
    setBusy(true);
    try { await api.post(`/accounts/${account.tenantId}/suspend`, { reason: reason.trim() }); onChanged(); }
    finally { setBusy(false); }
  }

  return (
    <tr>
      <Td className="font-medium text-slate-900">{account.name}</Td>
      <Td className="font-mono text-xs text-slate-500">{account.tenantId}</Td>
      <Td>{account.plan ?? <span className="text-slate-400">trial</span>}</Td>
      <Td>{account.region ?? <span className="text-slate-400">—</span>}</Td>
      <Td>
        {suspended
          ? <Badge tone="crit">Suspended</Badge>
          : <Badge tone="ok">Active</Badge>}
        {suspended && account.suspendedReason && (
          <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-slate-500">{account.suspendedReason}</p>
        )}
      </Td>
      <Td className="text-right">
        <Button variant={suspended ? 'ghost' : 'danger'} disabled={busy} onClick={toggle}>
          {suspended ? 'Reinstate' : 'Suspend'}
        </Button>
      </Td>
    </tr>
  );
}

function NewAccount({ onCancel, onCreated }: {
  onCancel: () => void; onCreated: (result: Provisioned) => void;
}) {
  const [form, setForm] = useState({
    tenantId: '', name: '', plan: '', region: '', email: '', fullName: '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      // superAdmin is nested, and the platform validates it as a nested object rather
      // than ignoring it — which it did not always do. Optional fields are omitted
      // rather than sent empty: the pipe rejects an empty string where it accepts
      // nothing at all.
      const result = await api.post<Provisioned>('/accounts', {
        tenantId: form.tenantId.trim(),
        name: form.name.trim(),
        ...(form.plan.trim() ? { plan: form.plan.trim() } : {}),
        ...(form.region.trim() ? { region: form.region.trim() } : {}),
        superAdmin: { email: form.email.trim(), fullName: form.fullName.trim() },
      });
      onCreated(result);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Could not create the account.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="New account"
      note="The tenant id is permanent and appears in every row this account ever owns. The super admin named here is the only person who can get in until they invite somebody else."
    >
      <form onSubmit={submit} className="space-y-4 px-5 py-5">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Account name" required placeholder="Acme Industries" value={form.name} onChange={set('name')} />
          <Field
            label="Tenant id" required placeholder="acme-industries" value={form.tenantId} onChange={set('tenantId')}
            hint="Lowercase and stable. It cannot be changed later."
          />
          <Field label="Plan" placeholder="pilot" value={form.plan} onChange={set('plan')} />
          <Field label="Region" placeholder="IN" value={form.region} onChange={set('region')} />
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
          <p className="mb-3 text-xs font-semibold text-slate-700">First administrator</p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Full name" required placeholder="Their Name" value={form.fullName} onChange={set('fullName')} />
            <Field
              label="Email" type="email" required placeholder="ops@acme.example"
              value={form.email} onChange={set('email')}
              hint="Their own domain, not a Things Alive address."
            />
          </div>
        </div>

        {problem && <Problem>{problem}</Problem>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * The invitation token comes back once and is never retrievable again — it is the only
 * route the first administrator has into their account. A screen that renders it in a
 * toast that fades has lost the account, so it sits here until it is dismissed.
 */
function InvitationHandover({ result, onDone }: { result: Provisioned; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Card
      title={`${result.tenant.name} is provisioned`}
      note="This token is shown once. It is how the first administrator sets a password; there is no way to read it back."
      right={<Button variant="ghost" onClick={onDone}>Done</Button>}
    >
      <div className="space-y-4 px-5 py-5">
        <dl className="grid grid-cols-3 gap-4 text-xs">
          <div><dt className="text-slate-500">Super admin</dt><dd className="mt-0.5 font-medium text-slate-900">{result.superAdmin.email}</dd></div>
          <div><dt className="text-slate-500">Roles created</dt><dd className="mt-0.5 font-medium text-slate-900">{result.roles.join(', ')}</dd></div>
          <div><dt className="text-slate-500">Token expires</dt><dd className="mt-0.5 font-medium text-slate-900">{new Date(result.invitationExpiresAt).toLocaleString()}</dd></div>
        </dl>

        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800">
            {result.invitationToken}
          </code>
          <Button
            variant="ghost"
            onClick={async () => {
              try { await navigator.clipboard.writeText(result.invitationToken); setCopied(true); }
              catch { setCopied(false); }
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>

        <p className="text-[11px] leading-relaxed text-slate-500">
          No catalog has been granted yet, so this account can sign in and see nothing.
          Grant it an equipment class from Entitlements — that is the step that copies the
          scenarios, alert templates and causal chain into their account.
        </p>
      </div>
    </Card>
  );
}
