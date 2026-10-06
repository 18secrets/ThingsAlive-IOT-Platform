#!/usr/bin/env node
/**
 * Fails when a source or doc file holds double-encoded text ("mojibake").
 *
 * PowerShell string interpolation and here-strings re-encode non-ASCII: an em dash
 * written as UTF-8, read back as Windows-1252 and written again becomes the three
 * characters U+00E2 U+20AC U+201D. Nothing fails when that lands in a comment, so two
 * files reached main before anyone noticed (data-source.ts since !54, page-widgets.ts
 * since !57). It will not be a comment every time.
 *
 * The patterns are written as escapes, not literals, so this file cannot trip itself.
 * Run by `npm run lint`, which both CI pipelines already call.
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['src', 'test', 'docs'];
const EXTENSIONS = new Set(['.ts', '.js', '.json', '.md', '.sql', '.yml', '.yaml']);

// U+00E2 U+20AC: the lead of every double-encoded punctuation mark (dashes, quotes, ellipsis).
// U+00C3 / U+00C2 followed by a C1/Latin-1 byte: double-encoded accented letters and symbols.
const MOJIBAKE = /â€|Ã[\u0080-¿]|Â[\u0080-¿]|ï¿½/;

const offenders = [];

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (MOJIBAKE.test(line)) offenders.push(`${full.replace(/\\/g, '/')}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
  }
}

for (const root of ROOTS) walk(root);

if (offenders.length) {
  process.stderr.write(
    `Double-encoded text (mojibake) in ${offenders.length} line(s) — restore the original characters:\n`
      + `${offenders.map((o) => `  ${o}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write('Encoding check: no double-encoded text under src/, test/ or docs/.\n');
