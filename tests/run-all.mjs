// Source Kit 0.1.0 — the validation lab: every suite, one tally
// Run every staged suite and report one tally.
//
// Suites are discovered from tests/.staged, so a new test-*.mts file is
// picked up with no list to maintain. Run `node tests/stage.mjs` first.
//
// Usage:  node tests/run-all.mjs [nameFilter]
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const staged = join(dirname(fileURLToPath(import.meta.url)), '.staged');
const tsx = join(staged, 'node_modules', '.bin', 'tsx');

if (!existsSync(tsx)) {
  console.error('staged lab is not installed. Run:');
  console.error('  node tests/stage.mjs && npm --prefix tests/.staged install');
  process.exit(1);
}

const filter = process.argv[2] ?? '';
const suites = readdirSync(staged)
  .filter((f) => f.startsWith('test-') && f.endsWith('.mts') && f.includes(filter))
  .sort();

if (suites.length === 0) {
  console.error(filter ? `no suite matches "${filter}"` : 'no suites found');
  process.exit(1);
}

const started = Date.now();
const failed = [];

for (const suite of suites) {
  const t0 = Date.now();
  const run = spawnSync(tsx, [suite], { cwd: staged, encoding: 'utf8' });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = (run.stdout ?? '') + (run.stderr ?? '');
  // Suites print their own "N passed, M failed" line; the exit code is the
  // authority, and the tally is shown when one is available.
  const tally = out.match(/(\d+) passed, (\d+) failed/g)?.pop() ?? '';
  const ok = run.status === 0;
  if (!ok) failed.push({ suite, out });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${suite.padEnd(34)} ${tally.padEnd(22)} ${secs}s`,
  );
}

for (const { suite, out } of failed) {
  console.log(`\n${'='.repeat(70)}\n${suite}\n${'='.repeat(70)}`);
  console.log(out.trimEnd().split('\n').slice(-40).join('\n'));
}

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(
  `\n${suites.length - failed.length}/${suites.length} suites passed in ${mins} min`,
);
process.exit(failed.length === 0 ? 0 : 1);
