import React from 'react';
import { Bus, Cog, Drill, Fan, Forklift, Tractor, Truck, Zap, type LucideIcon } from 'lucide-react';

/**
 * A picture of the kind of machine, from its class and name, where a plain cube said
 * nothing (2 Nov 2026). Classes are named by whoever authors them ("demo-excavator",
 * "tata-prima-3530-test", "ashokleyland-genset-180-test"), so this reads keywords
 * rather than a fixed list; a machine it cannot place gets a gear.
 */
const KINDS: [RegExp, LucideIcon][] = [
  [/forklift/, Forklift],
  [/excavator|loader|dozer|backhoe|grader|komatsu|hitachi|jcb|earthmov/, Tractor],
  [/truck|tipper|lorry|dumper|prima|trailer/, Truck],
  [/\bbus\b/, Bus],
  [/generator|genset|\bdg\b|kva/, Zap],
  [/compressor/, Fan],
  [/cnc|machining|lathe|milling|\bvmc\b/, Drill],
];

const kindOf = (text?: string | null): LucideIcon | undefined => {
  const t = (text ?? '').toLowerCase().replace(/[-_]/g, ' ');
  return t.trim() ? KINDS.find(([pattern]) => pattern.test(t))?.[1] : undefined;
};

/** The class decides; the name only when the class says nothing ("DG-…" classed as a compressor is a compressor). */
export function machineIconFor(classSlug?: string | null, name?: string | null): LucideIcon {
  return kindOf(classSlug) ?? kindOf(name) ?? Cog;
}

export const MachineIcon: React.FC<{ classSlug?: string | null; name?: string | null; className?: string }> = ({
  classSlug, name, className,
}) => {
  const Icon = machineIconFor(classSlug, name);
  return <Icon className={className} />;
};
