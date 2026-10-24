import React from 'react';

/**
 * The small slice of Markdown the assistant writes: paragraphs, bullet and numbered
 * lists, headings, **bold**, *italic* and `code`. Built as React elements rather than an
 * HTML string, so text the model echoes back (a machine name, say) can never become
 * markup. Anything outside the slice shows as the plain text it is. A library would
 * cover more, but would be a new dependency for a chat bubble.
 */

// Underscores mark emphasis only at word edges, as in CommonMark: signal names such as
// engine_coolant_temperature are snake_case, and read as "engine*coolant*temperature".
const INLINE = /(\*\*[^*]+\*\*|(?<![A-Za-z0-9])__[^_]+__(?![A-Za-z0-9])|`[^`]+`|\*[^*\s][^*]*\*|(?<![A-Za-z0-9])_[^_\s][^_]*_(?![A-Za-z0-9]))/g;

function inline(text: string, key: string): React.ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    const k = `${key}-${i}`;
    if (/^(\*\*|__).+\1$/.test(part)) return <strong key={k} className="font-semibold">{part.slice(2, -2)}</strong>;
    if (/^`.+`$/.test(part)) return <code key={k} className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-700/60 font-mono text-[0.9em]">{part.slice(1, -1)}</code>;
    if (/^([*_]).+\1$/.test(part)) return <em key={k}>{part.slice(1, -1)}</em>;
    return part;
  });
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] };

const BULLET = /^\s*[-*+•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

function blocks(source: string): Block[] {
  const out: Block[] = [];
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const last = out[out.length - 1];
    const bullet = line.match(BULLET);
    const numbered = line.match(NUMBERED);
    const heading = line.match(HEADING);
    if (!line.trim()) {
      out.push({ kind: 'p', lines: [] });
    } else if (heading) {
      out.push({ kind: 'h', text: heading[1] });
    } else if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      const item = (bullet ?? numbered)![1];
      if (last?.kind === kind) last.items.push(item);
      else out.push({ kind, items: [item] });
    } else if (last?.kind === 'p') {
      last.lines.push(line);
    } else if ((last?.kind === 'ul' || last?.kind === 'ol') && /^\s{2,}/.test(line)) {
      // An indented line continues the list item above it.
      last.items[last.items.length - 1] += ` ${line.trim()}`;
    } else {
      out.push({ kind: 'p', lines: [line] });
    }
  }
  return out.filter((b) => b.kind !== 'p' || b.lines.length > 0);
}

export const ChatMarkdown: React.FC<{ text: string }> = ({ text }) => (
  <div className="space-y-1.5">
    {blocks(text).map((b, i) => {
      const key = `b${i}`;
      switch (b.kind) {
        case 'h':
          return <p key={key} className="font-semibold">{inline(b.text, key)}</p>;
        case 'ul':
          return (
            <ul key={key} className="list-disc pl-4 space-y-0.5">
              {b.items.map((item, j) => <li key={j}>{inline(item, `${key}-${j}`)}</li>)}
            </ul>
          );
        case 'ol':
          return (
            <ol key={key} className="list-decimal pl-4 space-y-0.5">
              {b.items.map((item, j) => <li key={j}>{inline(item, `${key}-${j}`)}</li>)}
            </ol>
          );
        default:
          return <p key={key}>{b.lines.map((l, j) => <React.Fragment key={j}>{j > 0 && <br />}{inline(l, `${key}-${j}`)}</React.Fragment>)}</p>;
      }
    })}
  </div>
);
