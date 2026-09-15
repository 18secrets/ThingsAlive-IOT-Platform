import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './lib/session';
import { SignIn } from './shell/SignIn';
import { Shell } from './shell/Shell';
import { navFor } from './shell/nav';
import { Planned } from './screens/Planned';
import { Accounts } from './screens/things-alive/Accounts';
import { Entitlements } from './screens/things-alive/Entitlements';
import { DevicePool } from './screens/things-alive/DevicePool';
import { Catalog } from './screens/things-alive/Catalog';
import { Equipment } from './screens/client/Equipment';
import { Devices } from './screens/client/Devices';
import { Alerts } from './screens/client/Alerts';
import { Activations } from './screens/client/Activations';

const BUILT: Record<string, () => React.ReactElement> = {
  '/accounts': Accounts,
  '/entitlements': Entitlements,
  '/device-pool': DevicePool,
  '/catalog': Catalog,
  '/equipment': Equipment,
  '/devices': Devices,
  '/alerts': Alerts,
  '/activations': Activations,
};

function Console() {
  const s = useSession();

  if (s.status === 'loading') {
    return <div className="grid min-h-full place-items-center text-sm text-slate-500">Restoring your session…</div>;
  }
  if (s.status === 'anonymous') return <SignIn />;

  const items = navFor(s.can, s.me.isPlatformRole);
  // Where a caller lands is decided by what they may do. A platform role opens on
  // Accounts; an account's own user opens on their fleet. Nobody is sent to a screen
  // the API would refuse them.
  const home = items[0]?.path ?? '/accounts';

  return (
    <Routes>
      <Route element={<Shell />}>
        {items.map((item) => {
          const Built = BUILT[item.path];
          return (
            <Route
              key={item.path}
              path={item.path}
              element={Built ? <Built /> : <Planned path={item.path} />}
            />
          );
        })}
        <Route path="*" element={<Navigate to={home} replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Console />
      </BrowserRouter>
    </SessionProvider>
  );
}
