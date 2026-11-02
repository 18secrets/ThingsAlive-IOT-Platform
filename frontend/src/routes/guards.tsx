import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../lib/AuthProvider';
import { canOpenPath, firstAllowedPath } from '../lib/pageAccess';

function RestoringSession() {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-screen w-full place-items-center bg-[#F4F7FB] text-sm text-slate-500 dark:bg-slate-950 dark:text-slate-400">
      {t('common.restoringSession')}
    </div>
  );
}

/** Wraps every route that needs a signed-in user — /sign-in otherwise. */
export const RequireAuth: React.FC = () => {
  const { authUser, restoringSession, signedOutOnPurpose } = useAuth();
  const location = useLocation();
  if (restoringSession) return <RestoringSession />;
  // Where they were going, so signing in lands there and not on the dashboard — but not
  // after Log out: the next person to sign in was taken to the page the last one left.
  if (!authUser) {
    return <Navigate to="/sign-in" replace state={signedOutOnPurpose ? undefined : { from: `${location.pathname}${location.search}` }} />;
  }
  return <Outlet />;
};

/** Wraps /sign-in and /accept-invitation — already signed in skips straight past them. */
export const GuestOnly: React.FC = () => {
  const { authUser, restoringSession } = useAuth();
  const from = useReturnPath();
  if (restoringSession) return <RestoringSession />;
  // The page they were headed for only if it is theirs to open; otherwise their own
  // first page — the dashboard, where their role has one.
  if (authUser) {
    const to = from && canOpenPath(authUser, from) ? from : firstAllowedPath(authUser) ?? '/settings';
    return <Navigate to={to} replace />;
  }
  return <Outlet />;
};

/** The deep link a signed-out visit was headed for, or null. Only a path on this site:
 *  a `from` of "//elsewhere" would be an open redirect. */
export function useReturnPath(): string | null {
  const from = (useLocation().state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/sign-in')
    ? from : null;
}
