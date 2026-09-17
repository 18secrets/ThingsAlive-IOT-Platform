import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/AuthProvider';

function RestoringSession() {
  return (
    <div className="grid min-h-screen w-full place-items-center bg-[#F4F7FB] text-sm text-slate-500 dark:bg-slate-950 dark:text-slate-400">
      Restoring your session…
    </div>
  );
}

/** Wraps every route that needs a signed-in user — /sign-in otherwise. */
export const RequireAuth: React.FC = () => {
  const { authUser, restoringSession } = useAuth();
  if (restoringSession) return <RestoringSession />;
  if (!authUser) return <Navigate to="/sign-in" replace />;
  return <Outlet />;
};

/** Wraps /sign-in and /accept-invitation — already signed in skips straight past them. */
export const GuestOnly: React.FC = () => {
  const { authUser, restoringSession } = useAuth();
  if (restoringSession) return <RestoringSession />;
  if (authUser) return <Navigate to="/dashboard" replace />;
  return <Outlet />;
};
