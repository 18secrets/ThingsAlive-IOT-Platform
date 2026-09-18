import React from 'react';
import { ArrowLeft, Info } from 'lucide-react';

interface NotAvailableNoticeProps {
  title: string;
  children: React.ReactNode;
  onBack?: () => void;
}

/** For a screen whose real backend route is deliberately tenant-super-admin-only,
 *  and so has nothing to show a Master Admin drilling in from the Clients tab. */
export const NotAvailableNotice: React.FC<NotAvailableNoticeProps> = ({ title, children, onBack }) => (
  <div className="max-w-lg mx-auto py-16 text-center space-y-3">
    <div className="w-10 h-10 rounded-full bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400 flex items-center justify-center mx-auto">
      <Info className="w-5 h-5" />
    </div>
    <h3 className="font-semibold text-slate-800 dark:text-slate-100">{title}</h3>
    <p className="text-sm text-slate-500 dark:text-slate-400">{children}</p>
    {onBack && (
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-700 dark:text-sky-300 hover:underline cursor-pointer pt-2"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Back to Clients</span>
      </button>
    )}
  </div>
);
