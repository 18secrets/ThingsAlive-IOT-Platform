import React from 'react';
import { SelectPicker } from 'rsuite';
import { ArrowDownUp } from 'lucide-react';
import type { SortDir, SortState } from '../../lib/useSort';

/** The card view's sort control; the list view's headers set the same state. */
export function SortSelect<K extends string>({ options, sort, onChange }: {
  options: { key: K; dir: SortDir; label: string }[];
  sort: SortState<K>;
  onChange: (next: SortState<K>) => void;
}) {
  const value = `${sort.key}:${sort.dir}`;
  const data = options.map((o) => ({ label: o.label, value: `${o.key}:${o.dir}` }));
  // A header click can pick a pairing the menu does not list; show it rather than blank.
  // No fixed width: rsuite draws the box as wide as the chosen label inside whatever width
  // it is given, so a minimum left a gap before the view switch that grew as the label
  // shrank. As wide as its label, the gap beside it is the same for every choice.
  const known = data.some((d) => d.value === value);
  return (
    <span className="inline-flex items-center gap-1.5">
      <ArrowDownUp className="w-3.5 h-3.5 text-slate-400" />
      <SelectPicker
        size="sm"
        data={known ? data : [...data, { label: value, value }]}
        value={value}
        onChange={(v) => {
          if (!v) return;
          const [key, dir] = v.split(':') as [K, SortDir];
          onChange({ key, dir });
        }}
        searchable={false}
        cleanable={false}
      />
    </span>
  );
}
