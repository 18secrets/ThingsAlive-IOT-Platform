import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Type } from 'lucide-react';
import { TEXT_SIZES, TextSize, useTextSize } from '../../lib/textSize';

/** The header's text-size picker, built like the language picker beside it. */
export const TextSizeSelector: React.FC<{ align?: 'left' | 'right' }> = ({ align = 'right' }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [size, setSize] = useTextSize();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choose = (next: TextSize) => {
    setSize(next);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        id="text-size-btn"
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('header.textSize')}
        title={t('header.textSize')}
        className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
      >
        <Type className="w-4 h-4 text-slate-500" />
        <ChevronDown className="w-3 h-3 text-slate-400" />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={t('header.textSize')}
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} mt-2 w-40 bg-white dark:bg-slate-900 shadow-lg border border-slate-200 dark:border-slate-800 rounded-md py-1 text-xs z-50`}
        >
          {TEXT_SIZES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={size === s.id}
              onClick={() => choose(s.id)}
              className="w-full text-left px-3 py-1.5 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 cursor-pointer"
            >
              <span>{t(`header.textSizes.${s.id}`)} <span className="text-slate-400">· {s.scale}</span></span>
              {size === s.id && <Check className="w-3.5 h-3.5 text-sky-600" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
