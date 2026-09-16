import React, { useState, useMemo } from 'react';
import { Search, Plus, Building2, RotateCw, Ban, Edit2, UserRound, Phone, Mail, AlertCircle, KeyRound } from 'lucide-react';
import { ClientAccount, ClientUserItem, RoleDefinition } from '../../types';
import { AddClientModal } from './AddClientModal';

interface ClientManagementProps {
  clients: ClientAccount[];
  clientUsers: ClientUserItem[];
  roles: RoleDefinition[];
  onAddClient: (client: ClientAccount) => void;
  onUpdateClient: (client: ClientAccount) => void;
  onToggleStatus: (id: string) => void;
  onResetPassword: (id: string) => void;
  onManageAccess: (clientId: string) => void;
}

export const ClientManagement: React.FC<ClientManagementProps> = ({
  clients,
  clientUsers,
  roles,
  onAddClient,
  onUpdateClient,
  onToggleStatus,
  onResetPassword,
  onManageAccess,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<ClientAccount | null>(null);
  const [justReset, setJustReset] = useState<string | null>(null);

  const filteredClients = useMemo(() => {
    return clients.filter((c) =>
      c.clientName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.username.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.contactPersonName.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [clients, searchTerm]);

  const handleReset = (id: string) => {
    onResetPassword(id);
    setJustReset(id);
    setTimeout(() => setJustReset((current) => (current === id ? null : current)), 2000);
  };

  // The client card's "awaiting first login" badge reflects the actual Super
  // Admin login record, not the vestigial ClientAccount.mustChangePassword
  // field — the two can drift once a Super Admin has changed their password.
  const superAdminAwaitingLogin = (client: ClientAccount) => {
    const superAdmin = clientUsers.find(
      (u) => u.clientId === client.id && roles.find((r) => r.id === u.roleId)?.isSuperAdminRole
    );
    return superAdmin ? superAdmin.mustChangePassword : client.mustChangePassword;
  };

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
            placeholder="Search Client Name, Contact Person, or Username..."
            className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
          />
        </div>

        <button
          id="add-client-btn"
          onClick={() => {
            setEditingClient(null);
            setIsModalOpen(true);
          }}
          className="w-full sm:w-auto px-5 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add Client</span>
        </button>
      </div>

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
                  <span className="font-mono text-[11px] text-slate-400 truncate">{c.username}</span>
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
                    onClick={() => handleReset(c.id)}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                    title="Reset password & require change on next login"
                  >
                    <RotateCw className={`w-3.5 h-3.5 ${justReset === c.id ? 'animate-spin' : ''}`} />
                  </button>

                  <button
                    onClick={() => onManageAccess(c.id)}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                    title="Manage this client's users & roles"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={() => onToggleStatus(c.id)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer ${
                      c.status === 'Active' ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'
                    }`}
                    title={c.status === 'Active' ? 'Deactivate client' : 'Reactivate client'}
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

            <div className="space-y-1.5 text-xs text-slate-600 dark:text-slate-300">
              <div className="flex items-center gap-1.5 truncate">
                <UserRound className="w-3 h-3 text-sky-600 shrink-0" />
                <span className="truncate">{c.contactPersonName}</span>
              </div>
              <div className="flex items-center gap-1.5 truncate">
                <Phone className="w-3 h-3 text-sky-600 shrink-0" />
                <span className="font-mono truncate">{c.phone}</span>
              </div>
              <div className="flex items-center gap-1.5 truncate">
                <Mail className="w-3 h-3 text-sky-600 shrink-0" />
                <span className="truncate">{c.email}</span>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs">
              {superAdminAwaitingLogin(c) ? (
                <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800">
                  Awaiting First Login
                </span>
              ) : (
                <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase rounded border bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800">
                  Password Set
                </span>
              )}
              <span className={`font-semibold text-xs ${c.status === 'Active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}>
                {c.status === 'Active' ? '• Active' : '• Disabled'}
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
        onSave={(saved) => {
          if (editingClient) {
            onUpdateClient(saved);
          } else {
            onAddClient(saved);
          }
        }}
        existingUsernames={clientUsers
          .filter((u) => u.clientId !== editingClient?.id)
          .map((u) => u.username.toLowerCase())}
        existingClient={editingClient}
      />
    </div>
  );
};
