import 'reflect-metadata'; // standalone script: Nest normally loads this for us

import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { CatalogTemplateService } from './services/catalog-template.service';

/**
 * Writes the current catalog import template to disk (task QIMP1).
 *
 * The file this produces is the contract: every sheet the parser reads, the exact
 * headers, one filled example row and an `_enums` sheet of every fixed vocabulary it
 * knows about — handed to whoever writes the library content, with no separate
 * document required to make sense of it.
 *
 *   npx ts-node src/catalog-import/generate-template.ts [--out path/to/file.xlsx]
 */
function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const out = resolve(arg('out', argv) ?? 'equipment-library-template.xlsx');
  const buffer = await new CatalogTemplateService().build();
  writeFileSync(out, buffer);
  process.stdout.write(`\nWrote ${out}\n\n`);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

export { main };
