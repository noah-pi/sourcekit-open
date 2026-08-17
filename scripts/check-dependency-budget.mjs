#!/usr/bin/env node
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Dependency budget (supply-chain).
 *
 * Every direct dependency is an attack surface we vouch for. This script
 * fails CI when a package.json grows a dependency that is not on the
 * explicit allow-list below, or when the count exceeds the per-package cap.
 * Adding a dependency is a deliberate, reviewable act: edit the budget in
 * the same commit as the package.json change, with the reason in the
 * commit message.
 *
 * Run from the repo root:  node scripts/check-dependency-budget.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * allow: exact dependency names (dependencies + devDependencies).
 * cap:   hard ceiling on the total direct-dependency count.
 */
const BUDGET = {
  'desk/package.json': {
    allow: [
      '@noble/curves', '@noble/hashes', '@noble/ciphers', '@noble/post-quantum', 'cbor-x', 'react', 'react-dom',
      'jpeg-js',
      // Official C2PA engine (wasm fallback binding, pinned) for
      // desk/src/core/resolve.ts.
      '@contentauth/c2pa-wasm',
      '@types/node', '@types/react', '@types/react-dom', '@vitejs/plugin-react', 'tsx', 'typescript', 'vite',
    ],
    cap: 17,
  },
  'server/package.json': {
    allow: ['cbor-x'],
    cap: 3,
  },
};

let failures = 0;
for (const [rel, budget] of Object.entries(BUDGET)) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.error(`MISSING ${rel} — budget cannot be enforced against an absent manifest`);
    failures++;
    continue;
  }
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  const unvetted = deps.filter((d) => !budget.allow.includes(d));
  const dropped = budget.allow.filter((d) => !deps.includes(d));
  let bad = false;
  if (unvetted.length > 0) {
    console.error(`${rel}: UNVETTED dependencies: ${unvetted.join(', ')} — vet them and update the budget in the same commit`);
    failures++; bad = true;
  }
  if (deps.length > budget.cap) {
    console.error(`${rel}: ${deps.length} direct dependencies exceeds the cap of ${budget.cap}`);
    failures++; bad = true;
  }
  if (dropped.length > 0) {
    console.error(`${rel}: budget lists ${dropped.join(', ')} but package.json does not — prune the budget`);
    failures++; bad = true;
  }
  if (!bad) console.log(`ok   ${rel}: ${deps.length}/${budget.cap} direct dependencies, all vetted`);
}

// Lockfile discipline: every budgeted package must pin with a lockfile.
for (const rel of Object.keys(BUDGET)) {
  const lock = path.join(root, path.dirname(rel), 'package-lock.json');
  if (!fs.existsSync(lock)) {
    console.error(`${rel}: no package-lock.json — dependencies must be pinned`);
    failures++;
  } else {
    console.log(`ok   ${rel}: lockfile present`);
  }
}

// Resolved-VERSION budget: names alone undercount the
// supply chain — two resolved versions of one package are two copies of
// every primitive to vet. Any package whose lockfile resolves to MORE THAN
// ONE version must be declared here with the exact version set and the
// reason; an undeclared split fails the gate.
const KNOWN_VERSION_SPLITS = {
  'desk/package-lock.json': {
    // @noble/post-quantum@ is written against the noble 2.x API line
    // (it imports 2.x-only modules such as @noble/curves/abstract/fft.js),
    // while the rest of the tree pins the 1.x line. npm overrides CANNOT
    // safely collapse these — forcing one line breaks the other consumer
    // (tests/test-pq.mts pins the PQ behavior). The split is accepted,
    // documented in docs/DECISIONS.md, and re-vetted on every bump.
    '@noble/ciphers': ['1.3.0', '2.2.0'],
    '@noble/curves': ['1.9.7', '2.2.0'],
    '@noble/hashes': ['1.8.0', '2.2.0'],
    // Dev tooling only (never shipped): vite pins esbuild, tsx pins
    // 0.28.x. Build-time bundlers, not runtime attack surface.
    'esbuild': ['0.25.12', '0.28.2'],
  },
};
for (const [lockRel, known] of Object.entries(KNOWN_VERSION_SPLITS)) {
  const lockPath = path.join(root, lockRel);
  if (!fs.existsSync(lockPath)) continue;
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const versionsByName = new Map(); // name → Set<version>
  for (const [loc, info] of Object.entries(lock.packages ?? {})) {
    const m = loc.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
    if (!m || !info.version) continue;
    // OS-conditioned optional packages (esbuild/@rollup platform binaries)
    // are never co-resident: exactly one installs per platform, so a
    // "split" across them is an artifact of the lockfile listing every
    // platform, not two copies on any machine.
    if (info.optional && info.os) continue;
    if (!versionsByName.has(m[1])) versionsByName.set(m[1], new Set());
    versionsByName.get(m[1]).add(info.version);
  }
  let totalVersions = 0;
  for (const [name, versions] of versionsByName) {
    totalVersions += versions.size;
    if (versions.size <= 1) continue;
    const declared = known[name];
    const actual = [...versions].sort();
    if (declared && JSON.stringify([...declared].sort()) === JSON.stringify(actual)) {
      console.log(`ok   ${lockRel}: ${name} resolves to ${actual.length} DECLARED versions (${actual.join(', ')})`);
    } else {
      console.error(`${lockRel}: ${name} resolves to ${actual.length} versions (${actual.join(', ')}) — undeclared version split; vet it and declare it in KNOWN_VERSION_SPLITS with the reason`);
      failures++;
    }
  }
  console.log(`info ${lockRel}: ${versionsByName.size} package names, ${totalVersions} resolved versions`);
}

if (failures > 0) {
  console.error(`\nDependency budget FAILED (${failures} problem${failures === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log('\nDependency budget OK');
