import React, { useEffect, useState } from 'react';
import { X, Copy, CheckCheck } from 'lucide-react';
import { ApiError, InvitePlatformStaffResult, PlatformStaffRole } from '../../lib/api';

interface InviteStaffModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInvite: (input: {
    email: string; fullName: string; role: PlatformStaffRole;
  }) => Promise<InvitePlatformStaffResult>;
}

const ROLES: { value: PlatformStaffRole; label: string; description: string }[] = [
  { value: 'master-admin', label: 'Master Admin', description: 'Full platform control — accounts, staff, the catalog, everything.' },
  { value: 'platform-support', label: 'Platform Support', description: 'Operational access without staff or catalog authoring.' },
  { value: 'catalog-author', label: 'Catalog Author', description: 'Authors the equipment class catalog only.' },
];

export const InviteStaffModal: React.FC<InviteStaffModalProps> = ({ isOpen, onClose, onInvite }) => {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<PlatformStaffRole>('catalog-author');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [invited, setInvited] = useState<InvitePlatformStaffResult | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setEmail('');
    setFullName('');
    setRole('catalog-author');
    setError(undefined);
    setInvited(null);
    setCopied(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalEmail = email.trim();
    const finalName = fullName.trim();
    if (!finalEmail || !finalName) return;

    setBusy(true);
    setError(undefined);
    try {
      const result = await onInvite({ email: finalEmail, fullName: finalName, role });
      setInvited(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not invite this person.');
    } finally {
      setBusy(false);
    }
  };

  const handleCopyToken = () => {
    if (!invited) return;
    navigator.clipboard?.writeText(invited.invitationToken).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md overflow-hidden">

        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">
            {invited ? 'Staff Invited' : 'Invite Staff'}
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {invited ? (
          <div className="p-6 space-y-4 text-sm">
            <p className="text-slate-600 dark:text-slate-300">
              <strong className="text-slate-900 dark:text-white">{invited.fullName}</strong> is invited as{' '}
              <strong className="font-mono">{invited.role}</strong>.
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Invitation Token
              </label>
              <div className="relative">
                <input
                  readOnly
                  value={invited.invitationToken}
                  className="w-full px-3 py-2 pr-9 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 font-mono"
                />
                <button
                  type="button"
                  onClick={handleCopyToken}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                  title="Copy token"
                >
                  {copied ? <CheckCheck className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                Expires {new Date(invited.invitationExpiresAt).toLocaleString()}. There is no password to hand
                over — they set their own via <code>POST /platform/auth/accept-invitation</code> with this token.
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
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Full Name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                autoFocus
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Deepak Rao"
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Email <span className="text-rose-500">*</span>
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="e.g. deepak@thingsalive.io"
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Role <span className="text-rose-500">*</span>
              </label>
              <div className="space-y-2">
                {ROLES.map((r) => (
                  <label
                    key={r.value}
                    className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                      role === r.value
                        ? 'border-sky-300 dark:border-sky-700 bg-sky-50 dark:bg-sky-950/40'
                        : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    <input
                      type="radio"
                      name="platform-role"
                      value={r.value}
                      checked={role === r.value}
                      onChange={() => setRole(r.value)}
                      className="mt-0.5 cursor-pointer"
                    />
                    <div>
                      <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{r.label}</p>
                      <p className="text-[11px] text-slate-400">{r.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {error && (
              <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs transition-colors cursor-pointer disabled:opacity-60"
              >
                {busy ? 'Inviting…' : 'Send Invitation'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
