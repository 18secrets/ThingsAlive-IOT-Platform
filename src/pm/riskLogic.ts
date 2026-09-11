/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Predictive Maintenance — risk scoring rules, applied consistently everywhere.
 *
 * Each signal is scored against that device's own 90-day baseline as a z-score.
 * Per-signal status thresholds:
 *   |z| < 1.5            -> normal
 *   1.5 <= |z| < 2.5      -> warning
 *   |z| >= 2.5            -> critical
 *
 * A machine with 3+ signals trending abnormally (warning or critical) at the same
 * time is auto-flagged high priority (see HIGH_PRIORITY_SIGNAL_THRESHOLD below) —
 * this is surfaced explicitly in the UI as an "X/Y signals" badge everywhere a
 * machine is shown, and X must always equal machine.abnormalParameters.length.
 */

import { ParamStatus, Severity, ChipTone } from './types';

export const WARNING_Z = 1.5;
export const CRITICAL_Z = 2.5;
export const HIGH_PRIORITY_SIGNAL_THRESHOLD = 3;

export function statusFromZScore(zScore: number): ParamStatus {
  const abs = Math.abs(zScore);
  if (abs >= CRITICAL_Z) return 'critical';
  if (abs >= WARNING_Z) return 'warning';
  return 'normal';
}

/** Composite 0-100 risk score from a set of per-signal z-scores. */
export function compositeRiskScore(zScores: number[]): number {
  const weighted = zScores.reduce((sum, z) => sum + Math.min(Math.abs(z), 4), 0);
  const score = 5 + weighted * 9;
  return Math.max(2, Math.min(99, Math.round(score)));
}

export function severityFromRiskScore(riskScore: number): Severity {
  if (riskScore >= 80) return 'critical';
  if (riskScore >= 60) return 'high';
  if (riskScore >= 35) return 'medium';
  if (riskScore >= 15) return 'low';
  return 'none';
}

export function chipToneFromStatus(status: ParamStatus): ChipTone {
  return status === 'critical' ? 'critical' : status === 'warning' ? 'warning' : 'normal';
}

/** Tailwind classes for a severity badge/border — same meaning used on every chip/badge/border. */
export function severityClasses(severity: Severity): { badge: string; dot: string; text: string; border: string } {
  switch (severity) {
    case 'critical':
      return {
        badge: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
        dot: 'bg-rose-500',
        text: 'text-rose-600 dark:text-rose-400',
        border: 'border-rose-300 dark:border-rose-800',
      };
    case 'high':
      return {
        badge: 'bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-800',
        dot: 'bg-orange-500',
        text: 'text-orange-600 dark:text-orange-400',
        border: 'border-orange-300 dark:border-orange-800',
      };
    case 'medium':
      return {
        badge: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
        dot: 'bg-amber-500',
        text: 'text-amber-600 dark:text-amber-400',
        border: 'border-amber-300 dark:border-amber-800',
      };
    case 'low':
      return {
        badge: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800',
        dot: 'bg-sky-500',
        text: 'text-sky-600 dark:text-sky-400',
        border: 'border-sky-300 dark:border-sky-800',
      };
    default:
      return {
        badge: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
        dot: 'bg-emerald-500',
        text: 'text-emerald-600 dark:text-emerald-400',
        border: 'border-emerald-300 dark:border-emerald-800',
      };
  }
}

/** Tailwind classes for a per-signal status chip/border — same "good / attention / critical" meaning everywhere. */
export function statusClasses(status: ParamStatus): { badge: string; dot: string; text: string; border: string; bar: string; stroke: string } {
  switch (status) {
    case 'critical':
      return {
        badge: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
        dot: 'bg-rose-500',
        text: 'text-rose-600 dark:text-rose-400',
        border: 'border-rose-300 dark:border-rose-800',
        bar: 'bg-rose-500',
        stroke: 'stroke-rose-500',
      };
    case 'warning':
      return {
        badge: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
        dot: 'bg-amber-500',
        text: 'text-amber-600 dark:text-amber-400',
        border: 'border-amber-300 dark:border-amber-800',
        bar: 'bg-amber-500',
        stroke: 'stroke-amber-500',
      };
    default:
      return {
        badge: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
        dot: 'bg-emerald-500',
        text: 'text-emerald-600 dark:text-emerald-400',
        border: 'border-emerald-300 dark:border-emerald-800',
        bar: 'bg-emerald-500',
        stroke: 'stroke-emerald-500',
      };
  }
}

export function severityLabel(severity: Severity): string {
  switch (severity) {
    case 'critical': return 'Critical';
    case 'high': return 'High';
    case 'medium': return 'Medium';
    case 'low': return 'Low';
    default: return 'Healthy';
  }
}
