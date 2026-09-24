import React, { useMemo, useState } from 'react';
import {
  Search,
  Plus,
  Upload,
  Download,
  Pencil,
  Trash2,
  ChevronUp,
  ChevronDown,
  BarChart3,
  UserCheck2,
  ShieldCheck,
  Crown,
  AlertCircle,
} from 'lucide-react';
import { PlatformUserItem, PlatformUserRole } from '../../types';
import { AddUserModal } from './AddUserModal';

interface UserManagementProps {
  users: PlatformUserItem[];
  onAddUser: (user: PlatformUserItem) => void;
  onUpdateUser: (user: PlatformUserItem) => void;
  onDeleteUser: (id: number) => void;
  onToggleUserStatus: (id: number) => void;
}

type SortKey = 'employeeId' | 'username' | 'email' | 'phone';

const ROLE_BADGE_STYLES: Record<PlatformUserRole, string> = {
  Operational: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800',
  Executive: 'bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800',
  Support: 'bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300 border-teal-200 dark:border-teal-800',
  Admin: 'bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-800',
  'Super Admin': 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
};

export const UserManagement: React.FC<UserManagementProps> = ({
  users,
  onAddUser,
  onUpdateUser,
  onDeleteUser,
  onToggleUserStatus,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<'All' | PlatformUserRole>('All');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<PlatformUserItem | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  const stats = useMemo(
    () => ({
      total: users.length,
      active: users.filter((u) => u.active).length,
      admin: users.filter((u) => u.role === 'Admin').length,
      superAdmin: users.filter((u) => u.role === 'Super Admin').length,
    }),
    [users]
  );

  const roles = useMemo(
    () => Array.from(new Set(users.map((u) => u.role))).sort(),
    [users]
  );

  const filteredUsers = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    let list = users.filter((u) => {
      const matchesSearch =
        !term ||
        u.username.toLowerCase().includes(term) ||
        u.email.toLowerCase().includes(term) ||
        u.employeeId.toLowerCase().includes(term) ||
        u.phone.includes(term);
      const matchesRole = roleFilter === 'All' || u.role === roleFilter;
      return matchesSearch && matchesRole;
    });

    if (sort) {
      list = [...list].sort((a, b) => {
        const cmp = a[sort.key].toLowerCase().localeCompare(b[sort.key].toLowerCase());
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    }

    return list;
  }, [users, searchTerm, roleFilter, sort]);

  const toggleSort = (key: SortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  };

  const handleExportCsv = () => {
    const header = ['ID', 'Employee ID', 'Username', 'Email Id', 'Role', 'Phone No', 'Status'];
    const rows = filteredUsers.map((u) => [
      u.id,
      u.employeeId,
      u.username,
      u.email,
      u.role,
      u.phone,
      u.active ? 'Active' : 'Inactive',
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'users.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const nextId = users.reduce((max, u) => Math.max(max, u.id), 0) + 1;

  const SortableHeader: React.FC<{ column: SortKey; children: React.ReactNode }> = ({ column, children }) => (
    <th
      className="px-4 py-3 text-left font-semibold cursor-pointer select-none whitespace-nowrap"
      onClick={() => toggleSort(column)}
    >
      <span className="inline-flex items-center">
        {children}
        <span className="inline-flex flex-col -space-y-1 ml-1">
          <ChevronUp className={`w-2.5 h-2.5 ${sort?.key === column && sort.dir === 'asc' ? 'text-sky-600' : 'text-slate-300 dark:text-slate-600'}`} />
          <ChevronDown className={`w-2.5 h-2.5 ${sort?.key === column && sort.dir === 'desc' ? 'text-sky-600' : 'text-slate-300 dark:text-slate-600'}`} />
        </span>
      </span>
    </th>
  );

  return (
    <div id="user-management-view" className="space-y-6">
      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={BarChart3} label="Total Users" value={stats.total} tone="blue" />
        <StatCard icon={UserCheck2} label="Active Users" value={stats.active} tone="orange" />
        <StatCard icon={ShieldCheck} label="Admin Users" value={stats.admin} tone="green" />
        <StatCard icon={Crown} label="Super Admin" value={stats.superAdmin} tone="amber" />
      </div>

      {/* Toolbar */}
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-col sm:flex-row gap-3 flex-1">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search User Details"
              className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
            />
          </div>

          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as 'All' | PlatformUserRole)}
            className="px-3 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:border-sky-500 cursor-pointer"
          >
            <option value="All">Select Role</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            id="add-user-btn"
            onClick={() => {
              setEditingUser(null);
              setIsModalOpen(true);
            }}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center gap-2 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add New User</span>
          </button>
          <button
            className="px-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer flex items-center gap-2"
            title="Bulk user upload isn't wired to a backend yet"
          >
            <Upload className="w-4 h-4" />
            <span>Upload Bulk Users</span>
          </button>
          <button
            onClick={handleExportCsv}
            className="px-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* Users Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 uppercase tracking-wide text-[10px]">
                <th className="px-4 py-3 text-left font-semibold">ID</th>
                <SortableHeader column="employeeId">Employee ID</SortableHeader>
                <SortableHeader column="username">Username</SortableHeader>
                <SortableHeader column="email">Email Id</SortableHeader>
                <th className="px-4 py-3 text-left font-semibold">Role</th>
                <SortableHeader column="phone">Phone No</SortableHeader>
                <th className="px-4 py-3 text-left font-semibold">Status</th>
                <th className="px-4 py-3 text-left font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredUsers.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30 transition-colors">
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{u.id}</td>
                  <td className="px-4 py-3 font-mono text-slate-700 dark:text-slate-200 whitespace-nowrap">{u.employeeId}</td>
                  <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-100">{u.username}</td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{u.email}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold uppercase border ${ROLE_BADGE_STYLES[u.role]}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-slate-600 dark:text-slate-300 whitespace-nowrap">{u.phone}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => onToggleUserStatus(u.id)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer ${
                        u.active ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'
                      }`}
                      title={u.active ? 'Deactivate user' : 'Activate user'}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          u.active ? 'translate-x-4.5' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setEditingUser(u);
                          setIsModalOpen(true);
                        }}
                        className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                        title="Edit User"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => onDeleteUser(u.id)}
                        className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer"
                        title="Delete User"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}

              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10">
                    <div className="flex flex-col items-center gap-2 text-slate-400 text-sm">
                      <AlertCircle className="w-5 h-5 text-slate-300 dark:text-slate-600" />
                      <span>No users found.</span>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <AddUserModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingUser(null);
        }}
        onSave={(saved) => {
          if (editingUser) {
            onUpdateUser(saved);
          } else {
            onAddUser(saved);
          }
        }}
        existingUsernames={users.filter((u) => u.id !== editingUser?.id).map((u) => u.username.toLowerCase())}
        existingEmployeeIds={users.filter((u) => u.id !== editingUser?.id).map((u) => u.employeeId.toLowerCase())}
        nextId={nextId}
        existingUser={editingUser}
      />
    </div>
  );
};

const STAT_STYLES: Record<'blue' | 'orange' | 'green' | 'amber', string> = {
  blue: 'bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400',
  orange: 'bg-orange-50 dark:bg-orange-950/40 text-orange-600 dark:text-orange-400',
  green: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400',
  amber: 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400',
};

const StatCard: React.FC<{
  icon: React.FC<{ className?: string }>;
  label: string;
  value: number;
  tone: 'blue' | 'orange' | 'green' | 'amber';
}> = ({ icon: Icon, label, value, tone }) => (
  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs flex items-center gap-3">
    <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${STAT_STYLES[tone]}`}>
      <Icon className="w-5 h-5" />
    </div>
    <div>
      <div className="text-xl font-semibold text-slate-800 dark:text-slate-100 leading-tight">{value}</div>
      <div className="text-[11px] text-slate-500 dark:text-slate-400">{label}</div>
    </div>
  </div>
);
