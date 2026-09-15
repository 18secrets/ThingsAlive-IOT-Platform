import { useState } from 'react';
import { useSession } from '../lib/session';
import { ApiError } from '../lib/api';
import { Button, Field } from './ui';

export function SignIn() {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      // The server's own words. 2.0 tells a wrong password apart from a locked account
      // apart from a suspended organisation, and the three need different things from
      // the person reading them — one needs to try again, one needs to wait, and one
      // needs to call their account manager.
      setProblem(err instanceof ApiError ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-16">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <div>
          <div className="mb-6 flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-sm font-bold text-white">TA</span>
            <span className="text-sm font-semibold text-slate-900">Things Alive</span>
          </div>
          <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
          <p className="mt-1 text-xs text-slate-500">
            Your console is decided by what your account may do, not by a separate address.
          </p>
        </div>

        <Field
          label="Email" type="email" required autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password" type="password" required autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)}
        />

        {problem && (
          <p role="alert" className="rounded-lg border border-crit-700/20 bg-crit-50 px-3 py-2 text-xs leading-relaxed text-crit-700">
            {problem}
          </p>
        )}

        <Button type="submit" disabled={busy} className="w-full justify-center py-2">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
