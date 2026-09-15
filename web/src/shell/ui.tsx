import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/** The small set of pieces every screen is built from, so twelve screens agree. */

export function Card({ title, note, right, children }: {
  title?: ReactNode; note?: ReactNode; right?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      {(title || right) && (
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
            {note && <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">{note}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({ variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
}) {
  const base = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition '
    + 'disabled:cursor-not-allowed disabled:opacity-50';
  const look = {
    primary: 'bg-brand-500 text-white hover:bg-brand-600',
    ghost: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
    danger: 'border border-crit-700/30 bg-crit-50 text-crit-700 hover:bg-crit-700 hover:text-white',
  }[variant];
  return <button {...props} className={`${base} ${look} ${props.className ?? ''}`} />;
}

export function Field({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  label: string; hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-700">{label}</span>
      <input
        {...props}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none
                   placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
      />
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'crit'; children: ReactNode }) {
  const look = {
    neutral: 'bg-slate-100 text-slate-600',
    ok: 'bg-ok-50 text-ok-600',
    warn: 'bg-warn-50 text-warn-700',
    crit: 'bg-crit-50 text-crit-700',
  }[tone];
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${look}`}>{children}</span>;
}

/**
 * An empty state says which of the three empties this is: nothing exists yet, nothing
 * matched, or something failed. A single "No data" makes the third look like the first,
 * and somebody spends an afternoon looking for records that were never going to load.
 */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-5 py-12 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">{children}</p>}
    </div>
  );
}

export function Problem({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-crit-700/20 bg-crit-50 px-4 py-3">
      <p className="flex-1 text-xs leading-relaxed text-crit-700">{children}</p>
      {onRetry && <Button variant="ghost" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th className={`px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 ${className}`}>
      {children}
    </th>
  );
}

export function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-5 py-3 align-middle text-sm text-slate-700 ${className}`}>{children}</td>;
}
