import React from 'react';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** The API's own rules (PasswordService.assertAcceptable), in its order, so nothing
 *  ticked here is refused there. The common-password and own-email rules stay with the
 *  API: one needs its list, the other the person's address. */
const RULES: { key: string; ok: (p: string) => boolean }[] = [
  { key: 'length', ok: (p) => p.length >= 8 },
  { key: 'upper', ok: (p) => /[A-Z]/.test(p) },
  { key: 'lower', ok: (p) => /[a-z]/.test(p) },
  { key: 'number', ok: (p) => /[0-9]/.test(p) },
  { key: 'special', ok: (p) => /[^A-Za-z0-9]/.test(p) },
];

export function passwordMeetsRules(password: string): boolean {
  return RULES.every((r) => r.ok(password));
}

/** Ticks each rule off as it is met, instead of one refusal after pressing the button. */
export const PasswordChecklist: React.FC<{ password: string }> = ({ password }) => {
  const { t } = useTranslation();
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]" aria-live="polite">
      {RULES.map((r) => {
        const ok = r.ok(password);
        return (
          <li key={r.key} className={`flex items-center gap-1 ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}>
            {ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
            {t(`passwordRules.${r.key}`)}
          </li>
        );
      })}
    </ul>
  );
};
