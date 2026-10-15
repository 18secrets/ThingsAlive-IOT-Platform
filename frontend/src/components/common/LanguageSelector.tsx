import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Globe } from 'lucide-react';
import { LANGUAGES } from '../../i18n';

/**
 * The one place a person picks their language — shown in the header and on the
 * sign-in screen, so it can be chosen before signing in. The choice is remembered
 * by i18next's detector (localStorage), so it survives a reload and a sign-out.
 */
export const LanguageSelector: React.FC<{ align?: 'left' | 'right' }> = ({ align = 'right' }) => {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = LANGUAGES.find((l) => l.code === i18n.resolvedLanguage) ?? LANGUAGES[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        id="lang-selector-btn"
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('common.language')}
        className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
      >
        <Globe className="w-4 h-4 text-slate-500" />
        <span className="font-medium">{current.short}</span>
        <ChevronDown className="w-3 h-3 text-slate-400" />
      </button>

      {open && (
        <div
          role="listbox"
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} mt-2 w-36 bg-white dark:bg-slate-900 shadow-lg border border-slate-200 dark:border-slate-800 rounded-md py-1 text-xs z-50`}
        >
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              type="button"
              role="option"
              aria-selected={current.code === lang.code}
              lang={lang.code}
              onClick={() => { i18n.changeLanguage(lang.code); setOpen(false); }}
              className="w-full text-left px-3 py-1.5 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 cursor-pointer"
            >
              <span>{lang.label}</span>
              {current.code === lang.code && <Check className="w-3.5 h-3.5 text-sky-600" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
