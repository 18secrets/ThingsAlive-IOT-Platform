import React from 'react';
import { ChevronRight } from 'lucide-react';
import { Table } from 'rsuite';

const { Column, HeaderCell, Cell } = Table;

export interface ListColumn {
  label: string;
  /** Right-align numbers so a column of them reads down. */
  align?: 'left' | 'right';
  /** A fixed width, for a column of buttons that must not be cut off; the others share the rest. */
  width?: number;
  /** Narrowest a shared-width column may get; past it the table scrolls sideways instead. */
  minWidth?: number;
}

type Row<T> = { key: string; row: T };

/** A click on a control inside the row (an action button, a link) is that control's, not the row's. */
const fromControl = (event: React.MouseEvent) =>
  (event.target as HTMLElement | null)?.closest('button, a, input, select, label, [role="button"], .rs-picker') != null;

/**
 * The list half of a cards/list page (see ViewModeToggle): the same rows the cards show,
 * one per line, in an rsuite Table — the component the rest of the console's tables are
 * moving to. Every row opens what its card opens, so switching view never changes what
 * a click does; the buttons in an actions column act on their own.
 */
export function ListTable<T>({ columns, rows, rowKey, cells, onOpen, bare }: {
  columns: ListColumn[];
  rows: T[];
  rowKey: (row: T) => string;
  cells: (row: T) => React.ReactNode[];
  onOpen?: (row: T) => void;
  /** Inside a card that already has a border: no frame of its own. */
  bare?: boolean;
}) {
  const data: Row<T>[] = rows.map((row) => ({ key: rowKey(row), row }));
  return (
    <div className={`${bare ? '' : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs '}overflow-hidden [&_.rs-table-cell-content]:text-[13px] [&_.rs-table-cell-header_.rs-table-cell-content]:text-xs`}>
      <Table<Row<T>, string>
        data={data}
        rowKey="key"
        autoHeight
        wordWrap="break-word"
        hover={!!onOpen}
        onRowClick={onOpen ? (r, event) => { if (!fromControl(event)) onOpen(r.row); } : undefined}
        rowClassName={onOpen ? 'cursor-pointer' : undefined}
      >
        {columns.map((c, i) => (
          <Column
            key={c.label}
            {...(c.width ? { width: c.width } : { flexGrow: 1, minWidth: c.minWidth ?? 100 })}
            align={c.align ?? 'left'}
            verticalAlign="middle"
            fullText={false}
          >
            <HeaderCell className="font-semibold">{c.label}</HeaderCell>
            <Cell>{(r: Row<T>) => cells(r.row)[i]}</Cell>
          </Column>
        ))}
        {onOpen ? (
          <Column width={40} align="center" verticalAlign="middle">
            <HeaderCell>{''}</HeaderCell>
            <Cell>{() => <ChevronRight className="w-4 h-4 text-slate-300" />}</Cell>
          </Column>
        ) : null}
      </Table>
    </div>
  );
}
