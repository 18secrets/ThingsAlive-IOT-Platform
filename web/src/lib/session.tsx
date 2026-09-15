import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, session as tokens } from './api';
import type { Capability, Me, Permissions } from './types';

type State =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'signed-in'; me: Me; can: Record<Capability, boolean> };

type SessionValue = State & {
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<SessionValue | null>(null);

/**
 * Who is signed in, and what they may do — asked of the server, never inferred.
 *
 * The capability map comes from /me/permissions, which the API computes with the same
 * function its guard enforces with. The alternative is comparing role names in
 * components, and roles are rows a client owns and can add to: a console that switches
 * on 'ceo-manager' breaks the first time a customer renames a role, and grants nothing
 * to the custom role they add beside it.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(
    tokens.looksSignedIn() ? { status: 'loading' } : { status: 'anonymous' },
  );

  const load = useCallback(async () => {
    const [me, permissions] = await Promise.all([
      api.get<Me>('/me'),
      api.get<Permissions>('/me/permissions'),
    ]);
    setState({ status: 'signed-in', me, can: permissions.capabilities });
  }, []);

  useEffect(() => {
    tokens.onSignedOut(() => setState({ status: 'anonymous' }));
    if (state.status !== 'loading') return;
    let live = true;
    (async () => {
      // A cold load has only the refresh token; the access token never survived the
      // reload, by design. One exchange turns it back into a session.
      const resumed = await api.resume();
      if (!live) return;
      if (!resumed) { tokens.clear(); setState({ status: 'anonymous' }); return; }
      try { await load(); } catch { if (live) { tokens.clear(); setState({ status: 'anonymous' }); } }
    })();
    return () => { live = false; };
    // Runs once, on the cold-load path only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    await api.signIn(email, password);
    await load();
  }, [load]);

  const signOut = useCallback(async () => {
    await api.signOut();
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo<SessionValue>(() => ({ ...state, signIn, signOut }), [state, signIn, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useSession outside a SessionProvider');
  return value;
}

/** Narrowed to a signed-in session. Only ever called inside the shell. */
export function useAuthed() {
  const s = useSession();
  if (s.status !== 'signed-in') throw new Error('useAuthed outside a signed-in shell');
  return s;
}
