import React, { createContext, useContext, useEffect, useState } from 'react';
import { AuthUser, NavigationTab } from '../types';
import {
  apiAcceptInvitation, apiMyPermissions, apiResume, apiSignIn, apiSignOut, hasStoredSession,
  PlatformStaffRole, setSessionDeadHandler, SignedInUser,
} from './api';

const SESSION_KEY = 'ta_session';

// The backend mints every platform-staff token (master-admin, platform-support,
// catalog-author) with this fixed tenant claim — it isn't a real account, just a
// value the guard needs present (src/platform/platform-token.ts). It's the one
// signal a sign-in response carries for "this was a platform_user, not an
// app_user" — see PlatformCredentialService's own comment on the same constant.
const PLATFORM_TENANT_ID = 'things-alive';

// Session lives in sessionStorage (per-tab) rather than localStorage (shared
// across tabs), so opening multiple tabs lets each one be signed in as a
// different user independently.
function loadSession(): AuthUser | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Builds the app's AuthUser shape from a real sign-in/refresh/accept response.
// Fetches /me/permissions for the real allowedTabs and capabilities — the
// signed-in user's own role, resolved server-side, is the only correct source
// for "which pages does this person see" and "are they this account's super
// admin" (holding both user.manage and role.manage).
async function authUserFromApi(user: SignedInUser): Promise<AuthUser> {
  if (user.tenantId === PLATFORM_TENANT_ID) {
    return {
      role: 'master-admin',
      username: user.email,
      // The real assignment (master-admin/platform-support/catalog-author) —
      // `role` above stays 'master-admin' for the shell gate; this is what
      // Settings shows.
      platformStaffRole: user.roleSlug as PlatformStaffRole,
    };
  }
  const { capabilities, allowedTabs } = await apiMyPermissions();
  return {
    role: 'client',
    username: user.email,
    clientId: user.tenantId,
    // The API has no tenant display name on a non-platform token — see
    // src/me/me.controller.ts — so the tenant id is what's shown until a
    // real screen exposes one.
    clientName: user.tenantId,
    userId: user.id,
    roleId: user.roleSlug,
    allowedTabs: allowedTabs as NavigationTab[],
    isSuperAdmin: !!(capabilities['user.manage'] && capabilities['role.manage']),
  };
}

interface AuthContextValue {
  authUser: AuthUser | null;
  /** True only while resuming a session on a cold load — the router shows a
   *  loading screen instead of bouncing to /sign-in and back. */
  restoringSession: boolean;
  signIn: (identifier: string, password: string) => Promise<void>;
  acceptInvitation: (token: string, password: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authUser, setAuthUser] = useState<AuthUser | null>(loadSession);
  const [restoringSession, setRestoringSession] = useState(() => hasStoredSession());

  // Resume a real session on a cold load. The cached AuthUser in
  // sessionStorage is what lets the shell render immediately without a flash
  // of the login screen, but it's just what was true at last write — only
  // the API can say whether the refresh token behind it still works.
  useEffect(() => {
    if (!restoringSession) return;
    let live = true;
    (async () => {
      const user = await apiResume();
      if (!live) return;
      // A dead refresh token means the cached session was a lie.
      setAuthUser(user ? await authUserFromApi(user) : null);
      if (live) setRestoringSession(false);
    })();
    return () => { live = false; };
    // Runs once, on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist session (per-tab)
  useEffect(() => {
    if (authUser) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(authUser));
    } else {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }, [authUser]);

  // A refresh token dying mid-session (revoked, expired, or the account
  // suspended) has to bounce this back to null, or every screen keeps
  // rendering as signed in while no request it makes will ever work again.
  useEffect(() => {
    setSessionDeadHandler(() => setAuthUser(null));
    return () => setSessionDeadHandler(null);
  }, []);

  // One real call for everyone — the backend's own /auth/sign-in decides
  // whether this is a Things Alive staff credential (platform_user) or a
  // tenant account (app_user) and returns the same shape either way.
  const signIn = async (identifier: string, password: string) => {
    const user = await apiSignIn(identifier, password);
    setAuthUser(await authUserFromApi(user));
  };

  const acceptInvitation = async (token: string, password: string) => {
    const user = await apiAcceptInvitation(token, password);
    setAuthUser(await authUserFromApi(user));
  };

  const signOut = () => {
    // Best-effort and fire-and-forget: the local session is cleared either
    // way, so a dead or unreachable server can't trap someone signed in.
    if (authUser) void apiSignOut();
    setAuthUser(null);
  };

  return (
    <AuthContext.Provider value={{ authUser, restoringSession, signIn, acceptInvitation, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth used outside AuthProvider');
  return value;
}
