import { useEffect, useMemo, useState } from 'react';
import {
  EquipmentProfile, MyEquipmentClass, Plant, WorkflowScope,
  apiListEquipment, apiListMyCatalogEquipmentClasses, apiListPlants,
} from '../../../lib/api';

/** A machine as a picker value: the two halves of its key, joined. */
export const machineKey = (m: { sourceSystem: string; externalId: string }) => `${m.sourceSystem}|${m.externalId}`;

/**
 * What a workflow can be scoped to in this account (machines, sites, classes), and the
 * signals each scope can read. A signal is offered only if a class the scope covers
 * declares it — the same check the server makes on save, so the picker cannot offer a
 * signal that save would refuse.
 */
export function useWorkflowScope() {
  const [machines, setMachines] = useState<EquipmentProfile[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [classes, setClasses] = useState<MyEquipmentClass[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([apiListEquipment(), apiListPlants(false), apiListMyCatalogEquipmentClasses()])
      .then(([m, p, c]) => { setMachines(m); setPlants(p); setClasses(c); })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return useMemo(() => {
    const classBySlug = new Map(classes.map((c) => [c.slug, c]));
    const signalsOf = (slugs: (string | null | undefined)[]) =>
      [...new Set(slugs.flatMap((s) => (s ? classBySlug.get(s)?.expectedSignals.map((e) => e.signal) ?? [] : [])))].sort();

    const signalsFor = (scope: WorkflowScope): string[] => {
      switch (scope.appliesTo) {
        case 'equipment': {
          const m = machines.find((x) => x.sourceSystem === scope.sourceSystem && x.externalId === scope.externalId);
          return signalsOf([m?.equipmentClassSlug]);
        }
        case 'equipment-class':
          return signalsOf([scope.equipmentClassSlug]);
        case 'plant':
          return signalsOf(machines.filter((m) => m.plantId === scope.plantId).map((m) => m.equipmentClassSlug));
        default:
          return signalsOf(machines.map((m) => m.equipmentClassSlug));
      }
    };

    const machineLabel = (m: EquipmentProfile) => `${m.externalId}${m.name ? ` · ${m.name}` : ''}`;
    /** Each signal's unit as its class declares it, for a value given in another unit to be converted. */
    const unitsFor = (scope: WorkflowScope): Record<string, string | null> => {
      const slugs = scope.appliesTo === 'equipment'
        ? [machines.find((x) => x.sourceSystem === scope.sourceSystem && x.externalId === scope.externalId)?.equipmentClassSlug]
        : scope.appliesTo === 'equipment-class' ? [scope.equipmentClassSlug]
          : scope.appliesTo === 'plant' ? machines.filter((m) => m.plantId === scope.plantId).map((m) => m.equipmentClassSlug)
            : machines.map((m) => m.equipmentClassSlug);
      const out: Record<string, string | null> = {};
      for (const s of slugs) for (const e of (s ? classBySlug.get(s)?.expectedSignals ?? [] : [])) if (!(e.signal in out)) out[e.signal] = e.unit;
      return out;
    };
    return { machines, plants, classes, error, signalsFor, unitsFor, machineLabel };
  }, [machines, plants, classes, error]);
}
