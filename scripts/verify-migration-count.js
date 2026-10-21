// Catches the class of failure task QGRANT0 §5 found: `tsc` does not prune
// orphaned output, so a compiled migration left over from a different branch's
// build rides along in the chain silently, with no error anywhere. Run after
// `npm run build` — a mismatch means dist/ was not clean before compiling, and
// the migration chain this run would produce is not the one the source tree says.
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
const distDir = path.join(__dirname, '..', 'dist', 'database', 'migrations');

const srcCount = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts')).length;
const distCount = fs.existsSync(distDir)
  ? fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).length
  : 0;

if (srcCount !== distCount) {
  console.error(
    `Migration count mismatch: ${srcCount} source file(s) in src/database/migrations, `
      + `${distCount} compiled file(s) in dist/database/migrations. `
      + 'dist/ is stale — run `npm run build` again (it clears dist/ first) rather than trusting it.',
  );
  process.exit(1);
}

console.log(`Migration count matches: ${srcCount} source, ${distCount} compiled.`);
