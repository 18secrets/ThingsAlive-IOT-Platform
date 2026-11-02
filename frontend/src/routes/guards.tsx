import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../lib/AuthProvider';

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
  const { authUser, restoringSession } = useAuth();
  const location = useLocation();
  if (restoringSession) return <RestoringSession />;
  // Where they were going, so signing in lands there and not on the dashboard.
  if (!authUser) return <Navigate to="/sign-in" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return <Outlet />;
};

/** Wraps /sign-in and /accept-invitation — already signed in skips straight past them. */
export const GuestOnly: React.FC = () => {
  const { authUser, restoringSession } = useAuth();
  const from = useReturnPath();
  if (restoringSession) return <RestoringSession />;
  if (authUser) return <Navigate to={from} replace />;
  return <Outlet />;
};

/** The deep link a signed-out visit was headed for, else the dashboard. Only a path on
 *  this site: a `from` of "//elsewhere" would be an open redirect. */
export function useReturnPath(): string {
  const from = (useLocation().state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/sign-in')
    ? from : '/dashboard';
}
