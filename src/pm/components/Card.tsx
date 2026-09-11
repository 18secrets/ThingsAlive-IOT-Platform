/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/** Standard white/slate-900 card shell used across every existing admin screen. */
export const PmCard: React.FC<{ children: React.ReactNode; className?: string; noPadding?: boolean }> = ({
  children,
  className = '',
  noPadding = false,
}) => (
  <div
    className={`bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs ${noPadding ? '' : 'p-5'} ${className}`}
  >
    {children}
  </div>
);

export const PmSectionTitle: React.FC<{ title: string; subtitle?: string; action?: React.ReactNode }> = ({
  title,
  subtitle,
  action,
}) => (
  <div className="flex items-start justify-between gap-3 mb-4">
    <div>
      <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">{title}</h3>
      {subtitle && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>}
    </div>
    {action}
  </div>
);

export const PmKpiCard: React.FC<{
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon: React.FC<{ className?: string }>;
  iconBg?: string;
  iconColor?: string;
  onClick?: () => void;
}> = ({ label, value, sub, icon: Icon, iconBg = 'bg-sky-50 dark:bg-sky-950/60', iconColor = 'text-sky-600 dark:text-sky-400', onClick }) => (
  <div
    onClick={onClick}
    className={`bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between ${
      onClick ? 'cursor-pointer hover:border-sky-300 dark:hover:border-sky-700 transition-colors' : ''
    }`}
  >
    <div className="min-w-0">
      <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 leading-snug">{label}</div>
      <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{value}</div>
      {sub && <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{sub}</div>}
    </div>
    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ml-2 ${iconBg} ${iconColor}`}>
      <Icon className="w-5 h-5" />
    </div>
  </div>
);

/** Simple 1-level breadcrumb link used to get back from a detail screen. */
export const PmBackLink: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    onClick={onClick}
    className="text-xs font-medium text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 transition-colors cursor-pointer inline-flex items-center gap-1"
  >
    ← {label}
  </button>
);
