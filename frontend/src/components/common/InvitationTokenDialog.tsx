import React, { useState } from 'react';
import { X, Copy, CheckCheck } from 'lucide-react';
import { Input } from 'rsuite';
import { ResendInvitationResult } from '../../lib/api';
import { copyToClipboard } from '../../lib/clipboard';

interface InvitationTokenDialogProps {
  result: ResendInvitationResult | null;
  onClose: () => void;
}

/**
 * Shows a freshly re-issued invitation token once, with a copy button. The token is
 * not stored anywhere the console can read it back, so this is the only chance to
 * pass it on.
 */
export const InvitationTokenDialog: React.FC<InvitationTokenDialogProps> = ({ result, onClose }) => {
  const [copied, setCopied] = useState(false);
  if (!result) return null;

  const handleCopy = () => {
    copyToClipboard(result.invitationToken).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    });
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">New Invitation Token</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4 text-sm">
          <p className="text-slate-600 dark:text-slate-300">
            The old token stopped working the moment this one was issued for{' '}
            <strong className="font-mono">{result.email}</strong>.
          </p>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Invitation Token
            </label>
            <div className="relative">
              <Input readOnly value={result.invitationToken} className="pr-9 font-mono" />
              <button
                type="button"
                onClick={handleCopy}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                title="Copy token"
              >
                {copied ? <CheckCheck className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Expires {new Date(result.invitationExpiresAt).toLocaleString()}.
            </p>
          </div>
          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-end">
            <button
              onClick={onClose}
              className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs transition-colors cursor-pointer"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
