import React, { useState, useMemo } from 'react';
import { Search, Plus, Building2, RotateCw, Edit2, UserRound, Phone, Mail, AlertCircle, KeyRound, Copy, CheckCheck, X } from 'lucide-react';
import { ClientAccount } from '../../types';
import { Account, ApiError, CreateAccountResult, ResendInvitationResult } from '../../lib/api';
import { AddClientModal } from './AddClientModal';

interface ClientManagementProps {
  clients: ClientAccount[];
  error?: string;
  onCreateAccount: (
    input: { tenantId: string; name: string; email: string; fullName: string; phone?: string },
  ) => Promise<CreateAccountResult>;
  onUpdateAccount: (
    tenantId: string,
    input: { name: string; email: string; fullName: string; phone?: string },
  ) => Promise<Account>;
  onResendInvitation: (tenantId: string) => Promise<ResendInvitationResult>;
  onToggleStatus: (id: string) => void;
}

// Viewing a client's own users has no backend route yet — a platform token
// cannot read inside a tenant today. Kept as a real, clickable button rather
// than removed, so the gap stays visible in the design instead of
// disappearing quietly.
const MANAGE_ACCESS_NOT_INTEGRATED =
  "Viewing a client's own users needs a backend route that does not exist yet — "
  + 'a platform token cannot read inside a tenant today.';

export const ClientManagement: React.FC<ClientManagementProps> = ({
  clients,
  error,
  onCreateAccount,
  onUpdateAccount,
  onResendInvitation,
  onToggleStatus,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<ClientAccount | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [reissued, setReissued] = useState<ResendInvitationResult | null>(null);
  const [copied, setCopied] = useState(false);

  const handleResetPasswordClick = async (client: ClientAccount) => {
    if (!client.mustChangePassword) {
      // The person already has a password — resending an invitation would not
      // help them, and there is no admin-forced reset built yet (only
      // self-service POST /auth/forgot-password, which needs their own action).
      window.alert(
        `${client.contactPersonName ?? 'This person'} already has a password set. `
        + 'An admin-forced reset needs a backend route that does not exist yet — '
        + 'they can use "forgot password" themselves instead.',
      );
      return;
    }
    setResendingId(client.id);
    try {
      const result = await onResendInvitation(client.id);
      setReissued(result);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not resend the invitation.');
    } finally {
      setResendingId(null);
    }
  };

  const handleCopyReissued = () => {
    if (!reissued) return;
    navigator.clipboard?.writeText(reissued.invitationToken).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  const filteredClients = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return clients.filter((c) =>
      c.clientName.toLowerCase().includes(term) ||
      c.id.toLowerCase().includes(term) ||
      (c.contactPersonName?.toLowerCase().includes(term) ?? false) ||
      (c.email?.toLowerCase().includes(term) ?? false)
    );
  }, [clients, searchTerm]);

  return (
    <div id="client-management-view" className="space-y-6">

      {/* Search / Add Bar */}
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 w-full sm:max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search Client Name or Account ID..."
            className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
          />
        </div>

        <button
          id="add-client-btn"
          onClick={() => {
            setEditingClient(null);
            setIsModalOpen(true);
          }}
          className="w-full sm:w-auto px-5 py-2.5 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add Client</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Client Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredClients.map((c) => (
          <div
            key={c.id}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex flex-col justify-between hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-4"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-8 h-8 rounded-full bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
                    <Building2 className="w-4 h-4" />
                  </div>
                  <span className="font-mono text-[11px] text-slate-400 truncate">{c.id}</span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => {
                      setEditingClient(c);
                      setIsModalOpen(true);
                    }}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                    title="Edit Client"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={() => handleResetPasswordClick(c)}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                    title={c.mustChangePassword ? 'Resend invitation' : 'Reset password (not integrated yet)'}
                  >
                    <RotateCw className={`w-3.5 h-3.5 ${resendingId === c.id ? 'animate-spin' : ''}`} />
                  </button>

                  <button
                    onClick={() => window.alert(MANAGE_ACCESS_NOT_INTEGRATED)}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                    title="Manage access (not integrated yet)"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={() => onToggleStatus(c.id)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer ${
                      c.status === 'Active' ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'
                    }`}
                    title={c.status === 'Active' ? 'Suspend account' : 'Reinstate account'}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        c.status === 'Active' ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>

              <h4 className="font-semibold text-slate-900 dark:text-white text-base leading-snug truncate" title={c.clientName}>
                {c.clientName}
              </h4>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Created: {c.createdAt}
              </p>
            </div>

            {/* The account's Super Admin — the only contact the API has, since
                there is no separate "contact person" concept on a real account. */}
            <div className="space-y-1.5 text-xs text-slate-600 dark:text-slate-300">
              <div className="flex items-center gap-1.5 truncate">
                <UserRound className="w-3 h-3 text-sky-600 shrink-0" />
                <span className="truncate">{c.contactPersonName ?? '—'}</span>
              </div>
              <div className="flex items-center gap-1.5 truncate">
                <Phone className="w-3 h-3 text-sky-600 shrink-0" />
                <span className="font-mono truncate">{c.phone ?? '—'}</span>
              </div>
              <div className="flex items-center gap-1.5 truncate">
                <Mail className="w-3 h-3 text-sky-600 shrink-0" />
                <span className="truncate">{c.email ?? '—'}</span>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs">
              {/* Real signal: app_user.status === 'invited' means the super
                  admin has never accepted their invitation, so no password
                  has ever been set — see ProvisioningService.superAdminsFor. */}
              {c.mustChangePassword ? (
                <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800">
                  Awaiting First Login
                </span>
              ) : (
                <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800">
                  Password Set
                </span>
              )}
              <span className={`font-semibold text-xs ${c.status === 'Active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}>
                {c.status === 'Active' ? '• Active' : '• Suspended'}
              </span>
            </div>
          </div>
        ))}

        {filteredClients.length === 0 && (
          <div className="col-span-full py-10 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
            <span>No clients found.</span>
          </div>
        )}
      </div>

      <AddClientModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingClient(null);
        }}
        onCreate={onCreateAccount}
        onUpdate={onUpdateAccount}
        existingClient={editingClient}
      />

      {reissued && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
              <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">New Invitation Token</h3>
              <button
                onClick={() => setReissued(null)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4 text-sm">
              <p className="text-slate-600 dark:text-slate-300">
                The old token stopped working the moment this one was issued for{' '}
                <strong className="font-mono">{reissued.email}</strong>.
              </p>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Invitation Token
                </label>
                <div className="relative">
                  <input
                    readOnly
                    value={reissued.invitationToken}
                    className="w-full px-3 py-2 pr-9 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 font-mono"
                  />
                  <button
                    type="button"
                    onClick={handleCopyReissued}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                    title="Copy token"
                  >
                    {copied ? <CheckCheck className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  Expires {new Date(reissued.invitationExpiresAt).toLocaleString()}.
                </p>
              </div>
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-end">
                <button
                  onClick={() => setReissued(null)}
                  className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs transition-colors cursor-pointer"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
