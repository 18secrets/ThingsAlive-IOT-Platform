import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ENTITIES } from '../src/database/data-source';

const SRC = join(__dirname, '..', 'src');

/**
 * 2.0 never writes to the existing platform (task P1-110).
 *
 * The connection is opened read-only, so Postgres refuses a write whatever the code
 * asks for — that is the real guarantee and there is a test for it. This is the
 * cheaper, earlier one: it fails in a diff rather than at runtime, and it catches the
 * shape of the mistake before anybody has to reason about transactions.
 *
 * Two rules. Nothing in the legacy module may contain a writing statement, and no
 * module outside it may reach for the legacy connection at all — a second caller
 * opening its own connection is how the read-only guarantee stops being one.
 */
describe('the boundary with the existing platform', () => {
  const legacyDir = join(SRC, 'legacy');

  const readFiles = (dir: string): { path: string; body: string }[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return readFiles(full);
      return e.name.endsWith('.ts') ? [{ path: full, body: readFileSync(full, 'utf8') }] : [];
    });

  it('issues nothing but reads against the existing platform', () => {
    // Deliberately crude: a comment mentioning INSERT trips it, and having to reword a
    // comment is a much smaller cost than a write reaching a customer's live database.
    const writing = /\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE)\b/i;
    const offenders = readFiles(legacyDir)
      .filter((f) => writing.test(f.body))
      .map((f) => relative(SRC, f.path));
    expect(offenders).toEqual([]);
  });

  it('keeps the legacy connection to one module', () => {
    const reachers = readFiles(SRC)
      .filter((f) => !f.path.startsWith(legacyDir))
      .filter((f) => /LEGACY_DATA_SOURCE|createLegacyDataSource|legacyConfigFrom/.test(f.body))
      .map((f) => relative(SRC, f.path));
    // The reader is injected; the connection itself is nobody else's to open.
    expect(reachers).toEqual([]);
  });
});

function filesUnder(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, suffix));
    else if (name.endsWith(suffix)) out.push(full);
  }
  return out;
}

/**
 * The registration nobody remembers (task P1-80).
 *
 * Four slices in a row shipped an entity file or a module that was written, tested in
 * isolation and never added to the two lists that make it real. It is the same
 * mistake every time, and it has a shape: every other file in a slice is new, while
 * `data-source.ts` and `app.module.ts` are existing files edited by hand in two
 * places each — an import, and a line in an array thirty lines below it. Adding the
 * import and forgetting the array leaves code that compiles, passes its own unit
 * tests, and does nothing.
 *
 * These two tests are cheap, need no database, and remove the class of mistake rather
 * than the instances of it. They are deliberately blunt: a file that declares
 * `@Entity(` must appear in `ENTITIES`, and a `*.module.ts` must appear in
 * `app.module.ts`. A file that genuinely should not be registered is listed below
 * with a reason, which makes the exception visible in a diff.
 */
describe('wiring', () => {
  /** Modules that are imported by another module rather than by the application root. */
  const NOT_ROOT_MODULES: Record<string, string> = {
    'app.module.ts': 'the root itself',
    'scope/scope.module.ts': 'imported by the modules that need a scoped repository',
  };

  it('registers every entity in the data source', () => {
    const declared = new Set(ENTITIES.map((e: any) => e.name));

    const missing: string[] = [];
    for (const file of filesUnder(SRC, '.entity.ts')) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('@Entity(')) continue;
      // One file can declare more than one entity — the two access tables do.
      for (const [, name] of source.matchAll(/export class (\w+)/g)) {
        if (!source.includes(`@Entity(`)) continue;
        if (!declared.has(name)) missing.push(`${relative(SRC, file)}: ${name}`);
      }
    }

    // An entity absent from this list has no table, no migration anybody notices, and
    // no row-level-security check — the derived coverage guard reads the same array,
    // so an unregistered entity is invisible to that too.
    expect(missing).toEqual([]);
    expect(ENTITIES.length).toBeGreaterThan(20);
  });

  it('imports every module into the application root', () => {
    const root = readFileSync(join(SRC, 'app.module.ts'), 'utf8');

    const missing: string[] = [];
    for (const file of filesUnder(SRC, '.module.ts')) {
      const key = relative(SRC, file).split('\\').join('/');
      if (NOT_ROOT_MODULES[key]) continue;

      const [, name] = readFileSync(file, 'utf8').match(/export class (\w+Module)/) ?? [];
      if (!name) continue;
      // Both halves: the import line and the use of it. Having one without the other
      // is exactly the mistake this test exists for, and it compiles.
      const imported = root.includes(`import { ${name} }`) || root.includes(`${name},`);
      const used = new RegExp(`\\b${name}\\b`, 'g');
      const occurrences = (root.match(used) ?? []).length;
      if (!imported || occurrences < 2) missing.push(key);
    }

    expect(missing).toEqual([]);
  });

  it('names a reason for every module that is not in the root', () => {
    for (const [file, reason] of Object.entries(NOT_ROOT_MODULES)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(file.endsWith('.module.ts')).toBe(true);
    }
  });
});
