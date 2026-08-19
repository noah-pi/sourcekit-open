#!/usr/bin/env node
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Audit gate (supply-chain).
 *
 * `npm audit --audit-level=high` is the right default, but it has no way to
 * say "we looked at this one and it cannot reach the app." Without that, a
 * build-time advisory with no upstream fix leaves the gate permanently red,
 * and a red gate is one nobody reads.
 *
 * So: every high or critical advisory fails the build unless it is declared
 * below with a reason. A new one still fails. Declaring one is a reviewable
 * act — put the reason in the same commit.
 *
 * Run from the repo root:  node scripts/check-audit.mjs <dir>
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Accepted advisories, per manifest directory, by the vulnerable package
 * name npm reports.
 *
 * `reaches` records what the package is actually pulled in by — an advisory
 * is only acceptable here if the answer is build tooling. Anything that ends
 * up in the shipped app is not a candidate for this list at any severity.
 */
const ACCEPTED_BY_DIR = {
  '.': {
    'image-size': {
      reaches: 'metro (the React Native bundler) — build time only, never bundled into the app',
      why: 'Denial of service parsing malformed ICNS/JXL/HEIF headers. The parser runs on assets we author, on a developer machine or CI runner. npm offers no forward fix: the only remediation it reports is a major-version DOWNGRADE of expo, which would cost far more than it buys.',
      advisories: ['GHSA-w3rx-r6r6-pgpr', 'GHSA-5p2g-fcmc-qvqq'],
    },
  },
  server: {},
};

const dir = process.argv[2] ?? '.';
const label = path.basename(path.resolve(dir)) || 'root';
const ACCEPTED = ACCEPTED_BY_DIR[dir];
if (!ACCEPTED) {
  console.error(`${label}: no declaration set for '${dir}' — add one to ACCEPTED_BY_DIR (an empty object means "nothing accepted here")`);
  process.exit(1);
}

let report;
try {
  // npm audit exits non-zero when it finds anything; the JSON is on stdout
  // either way, so the exit code is not the signal here — the parse is.
  report = JSON.parse(execFileSync('npm', ['audit', '--json'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
} catch (err) {
  if (!err.stdout) { console.error(`${label}: npm audit produced no report — ${err.message}`); process.exit(1); }
  report = JSON.parse(err.stdout);
}

let failures = 0;
// npm flags the whole chain: a package that merely DEPENDS on a vulnerable
// package inherits its severity, with `via` naming the dependency by string.
// Only entries whose `via` carries an advisory object are findings of their
// own — the rest are the same problem, counted again at each hop.
const serious = Object.entries(report.vulnerabilities ?? {})
  .filter(([, v]) => (v.severity === 'high' || v.severity === 'critical')
    && (v.via ?? []).some((x) => typeof x === 'object'));

for (const [name, v] of serious) {
  const accepted = ACCEPTED[name];
  if (!accepted) {
    const titles = (v.via ?? []).filter((x) => typeof x === 'object').map((x) => x.title);
    console.error(`${label}: UNDECLARED ${v.severity} advisory in ${name}${titles.length ? ` — ${titles.join('; ')}` : ''}`);
    console.error(`    reached via: ${(v.effects ?? []).join(', ') || 'a direct dependency'}`);
    console.error('    fix it, or declare it in scripts/check-audit.mjs with the reason it cannot reach the app');
    failures++;
    continue;
  }
  console.log(`ok   ${label}: ${name} (${v.severity}) — DECLARED: ${accepted.reaches}`);
}

// A declaration that no longer matches anything is stale: the advisory was
// fixed upstream, or the dependency is gone. Prune it rather than let the
// list accumulate exceptions nobody has re-read.
for (const name of Object.keys(ACCEPTED)) {
  if (!serious.some(([n]) => n === name)) {
    console.error(`${label}: ACCEPTED lists ${name} but npm audit no longer reports it at high or above — prune the declaration`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\nAudit gate FAILED for ${label} (${failures} problem${failures === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log(`Audit gate OK for ${label}: ${serious.length} high/critical advisor${serious.length === 1 ? 'y' : 'ies'}, all declared`);
