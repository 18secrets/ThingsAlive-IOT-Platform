import React, { useMemo, useState } from 'react';
import { Search, KeyRound, AlertCircle, Crown } from 'lucide-react';
import { ClientAccount, ClientUserItem, RoleDefinition } from '../../types';

interface AllClientUsersViewProps {
  clients: ClientAccount[];
  clientUsers: ClientUserItem[];
  roles: RoleDefinition[];
  onManage: (clientId: string) => void;
}

export const AllClientUsersView: React.FC<AllClientUsersViewProps> = ({ clients, clientUsers, roles, onManage }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [clientFilter, setClientFilter] = useState('All');

  const clientNameById = useMemo(() => {
    const map: Record<string, string> = {};
    clients.forEach((c) => { map[c.id] = c.clientName; });
    return map;
  }, [clients]);

  const filteredUsers = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return clientUsers.filter((u) => {
      const matchesClient = clientFilter === 'All' || u.clientId === clientFilter;
      const matchesSearch =
        !term ||
        u.name.toLowerCase().includes(term) ||
        u.username.toLowerCase().includes(term) ||
        (clientNameById[u.clientId] || '').toLowerCase().includes(term);
      return matchesClient && matchesSearch;
    });
  }, [clientUsers, searchTerm, clientFilter, clientNameById]);

  return (
    <div id="all-client-users-view" className="space-y-6">
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1 w-full sm:max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search Name, Username, or Client..."
            className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
          />
        </div>
        <select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          className="px-3 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:border-sky-500 cursor-pointer"
        >
          <option value="All">All Clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.clientName}</option>
          ))}
        </select>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold">
              <tr>
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4">Username</th>
                <th className="py-3 px-4">Client</th>
                <th className="py-3 px-4">Role</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredUsers.map((u) => {
                const role = roles.find((r) => r.id === u.roleId);
                return (
                  <tr key={u.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                      {u.name}
                      {role?.isSuperAdminRole && <span title="Super Admin"><Crown className="w-3.5 h-3.5 text-amber-500" /></span>}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-300">{u.username}</td>
                    <td className="py-3 px-4 text-slate-700 dark:text-slate-200">{clientNameById[u.clientId] || 'Unknown client'}</td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 font-medium text-[11px] border border-sky-200 dark:border-sky-800">
                        {role?.name || 'Unknown role'}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold uppercase border ${
                        u.active
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                      }`}>
                        {u.active ? 'Active' : 'Inactive'}
                      </span>
                      {u.mustChangePassword && (
                        <span className="ml-1.5 px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 font-medium text-[10px] border border-amber-200 dark:border-amber-800 uppercase">
                          Awaiting Login
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-center">
                        <button
                          onClick={() => onManage(u.clientId)}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer flex items-center gap-1.5 px-2.5"
                          title={`Manage users & roles for ${clientNameById[u.clientId] || 'this client'}`}
                        >
                          <KeyRound className="w-3.5 h-3.5" />
                          <span className="text-[11px] font-semibold">Manage</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10">
                    <div className="flex flex-col items-center gap-2 text-slate-400 text-sm">
                      <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
                      <span>No client users found.</span>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
