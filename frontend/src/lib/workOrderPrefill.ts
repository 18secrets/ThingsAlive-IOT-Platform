import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Prediction } from './api';

/**
 * "Create work order" from a machine (testing sheet TC_181, TC_182, 12 Nov): every button
 * that raises one opens the Work Orders form with the machine already chosen and the task
 * written from what the page knows — its worst prediction, or its downtime. The buttons
 * used to land on the Work Orders list, where the person chose the machine again.
 *
 * Carried in the navigation's state, read once by WorkOrdersPage, which opens the form.
 */
export interface WorkOrderRequest {
  sourceSystem: string;
  externalId: string;
  title: string;
  description?: string;
  /** Links the job to the prediction it came from. */
  predictionId?: string;
}

export interface WorkOrderContext {
  machine: { sourceSystem: string; externalId: string; name?: string | null };
  /** The page this came from, said in the note ("Raised from ThingsCare: …"). */
  from: 'predictions' | 'thingsCare' | 'production' | 'machine';
  /** The machine's worst prediction, when the page has one. */
  worst?: Prediction | null;
  /** The scenario's name, when the page knows it; its slug otherwise. */
  scenarioName?: string | null;
  /** Hours down over the page's last `days`, for Production Monitoring. */
  downtime?: { hours: number; days: number } | null;
}

export function workOrderRequest(tr: TFunction, c: WorkOrderContext): WorkOrderRequest {
  const t = (key: string, options?: Record<string, unknown>) => tr(`workOrders:prefill.${key}`, options ?? {}) as string;
  const machine = c.machine.name || c.machine.externalId;
  const from = t(`from.${c.from}`);
  const base = { sourceSystem: c.machine.sourceSystem, externalId: c.machine.externalId };
  if (c.worst) {
    const scenario = c.scenarioName || c.worst.clientScenarioSlug;
    return {
      ...base,
      title: t('titleFromPrediction', { scenario, machine }),
      description: t('noteFromPrediction', {
        from, scenario, risk: Math.round(c.worst.riskScore),
        severity: tr(`predictions:severity.${c.worst.severity}`, { defaultValue: c.worst.severity }) as string,
      }),
      predictionId: c.worst.id,
    };
  }
  if (c.downtime && c.downtime.hours > 0) {
    return {
      ...base,
      title: t('titleFromDowntime', { machine }),
      description: t('noteFromDowntime', { from, hours: Math.round(c.downtime.hours), count: c.downtime.days }),
    };
  }
  return { ...base, title: t('titleInspect', { machine }), description: t('noteFrom', { from }) };
}

/**
 * Opens Work Orders with the form filled for a machine. A hook, not a plain function: the
 * workOrders namespace loads only where it is asked for, and a page that never asked
 * printed the keys themselves into the form.
 */
export function useRaiseWorkOrder(): (c: WorkOrderContext) => void {
  const navigate = useNavigate();
  const { t } = useTranslation(['workOrders', 'predictions']);
  return useCallback(
    (c: WorkOrderContext) => navigate('/work-orders', { state: { createWorkOrder: workOrderRequest(t, c) } }),
    [navigate, t],
  );
}
