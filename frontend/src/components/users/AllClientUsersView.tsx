import React, { useMemo, useState } from 'react';
import { Search, KeyRound, AlertCircle, Crown } from 'lucide-react';
import { Input, SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('users');

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
    <div id="all-client-users-view" className="space-y-3">
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1 w-full max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            value={searchTerm}
            onChange={(value) => setSearchTerm(value)}
            placeholder={t('allClientUsers.searchPlaceholder')}
            className="pl-9!"
            size="sm"
          />
        </div>
        <SelectPicker
          data={[{ label: t('allClientUsers.allClients'), value: 'All' }, ...clients.map((c) => ({ label: c.clientName, value: c.id }))]}
          value={clientFilter}
          onChange={(value) => setClientFilter(value ?? 'All')}
          searchable={false}
          cleanable={false}
          size="sm"
        />
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold">
              <tr>
                <th className="py-3 px-4">{t('col.name')}</th>
                <th className="py-3 px-4">{t('col.username')}</th>
                <th className="py-3 px-4">{t('col.client')}</th>
                <th className="py-3 px-4">{t('col.role')}</th>
                <th className="py-3 px-4">{t('col.status')}</th>
                <th className="py-3 px-4 text-center">{t('col.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredUsers.map((u) => {
                const role = roles.find((r) => r.id === u.roleId);
                return (
                  <tr key={u.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                      {u.name}
                      {role?.isSuperAdminRole && <span title={t('common.superAdmin')}><Crown className="w-3.5 h-3.5 text-amber-500" /></span>}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-300">{u.username}</td>
                    <td className="py-3 px-4 text-slate-700 dark:text-slate-200">{clientNameById[u.clientId] || t('allClientUsers.unknownClient')}</td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 font-medium text-[11px] border border-sky-200 dark:border-sky-800">
                        {role?.name || t('allClientUsers.unknownRole')}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold uppercase border ${
                        u.active
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                      }`}>
                        {u.active ? t('status.active') : t('status.inactive')}
                      </span>
                      {u.mustChangePassword && (
                        <span className="ml-1.5 px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 font-medium text-[10px] border border-amber-200 dark:border-amber-800 uppercase">
                          {t('common.awaitingLogin')}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-center">
                        <button
                          onClick={() => onManage(u.clientId)}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer flex items-center gap-1.5 px-2.5"
                          title={t('allClientUsers.manageTitle', { client: clientNameById[u.clientId] || t('allClientUsers.thisClient') })}
                        >
                          <KeyRound className="w-3.5 h-3.5" />
                          <span className="text-[11px] font-semibold">{t('allClientUsers.manage')}</span>
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
                      <span>{t('allClientUsers.empty')}</span>
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
