import { NavLink, Outlet } from 'react-router-dom';
import { useAuthed, useSession } from '../lib/session';
import { CLIENT, THINGS_ALIVE, navFor } from './nav';

/**
 * One shell, two consoles.
 *
 * The rail is built from the capability map, so the difference between a Things Alive
 * screen list and a client's is what the server says the caller may do. The accent
 * follows the same signal rather than a second theme: a platform role gets brand teal,
 * an account gets slate, and nobody has to remember which build they are looking at.
 */
export function Shell() {
  const { me, can } = useAuthed();
  const { signOut } = useSession();
  const items = navFor(can);
  const platform = me.isPlatformRole;

  const group = (label: string, source: typeof THINGS_ALIVE) => {
    const mine = items.filter((i) => source.includes(i));
    if (!mine.length) return null;
    return (
      <div className="mb-6">
        <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
        <nav className="space-y-0.5">
          {mine.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive
                    ? platform ? 'bg-brand-500 text-white' : 'bg-slate-800 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    );
  };

  return (
    <div className="flex min-h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white px-3 py-5">
        <div className="mb-7 flex items-center gap-2 px-3">
          <span className={`grid h-8 w-8 place-items-center rounded-lg text-sm font-bold text-white ${
            platform ? 'bg-brand-500' : 'bg-slate-800'
          }`}>TA</span>
          <span className="text-sm font-semibold text-slate-900">Things Alive</span>
        </div>

        {group('Platform', THINGS_ALIVE)}
        {group(platform ? 'Cross-account' : 'Fleet', CLIENT)}

        <div className="mt-auto border-t border-slate-100 px-3 pt-4">
          <p className="truncate text-xs font-medium text-slate-700">{me.userId}</p>
          <p className="mt-0.5 truncate text-[11px] text-slate-500">
            {me.roles.join(', ')} · {me.tenantId}
          </p>
          <button
            onClick={signOut}
            className="mt-2 text-[11px] font-semibold text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

export function Page({ title, lede, right, children }: {
  title: string; lede?: string; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <header className="mb-6 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
          {lede && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">{lede}</p>}
        </div>
        {right}
      </header>
      <div className="space-y-5">{children}</div>
    </div>
  );
}
