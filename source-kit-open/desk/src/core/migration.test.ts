/**
 * migration.test.ts — the two rename migrations of ARCHITECTURE §7:
 *  1. localStorage verifyDesk.* → exhibitC.* (copy-and-remove, known keys
 *     only, legacy untouched when the new key already has a value);
 *  2. CLI config dir ~/.exhibit-desk → ~/.exhibit-c (copy, one-line notice,
 *     legacy dir never deleted).
 *
 * Runs under `tsx --test` (node:test) — no test-runner dependency added.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { migrateLocalStorage, LS_KEYS, type StorageLike } from './storageMigration';
import { migrateConfigDir, type MigrateFs } from '../../cli/deskKey';

/* ------------------------------------------------------------------ */
/* localStorage                                                        */
/* ------------------------------------------------------------------ */

function memStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

test('localStorage: known legacy keys are copied to exhibitC.* and removed', () => {
  const s = memStorage({
    'verifyDesk.rosters.v1': '[{"newsroom":"Example roster"}]',
    'verifyDesk.thresholds.v1': '{"likely":5,"possible":9}',
  });
  const migrated = migrateLocalStorage(s);
  assert.deepEqual([...migrated].sort(), ['verifyDesk.rosters.v1', 'verifyDesk.thresholds.v1']);
  assert.equal(s.map.get(LS_KEYS.rosters), '[{"newsroom":"Example roster"}]');
  assert.equal(s.map.get(LS_KEYS.thresholds), '{"likely":5,"possible":9}');
  // Copy-AND-remove: the old keys are gone.
  assert.equal(s.map.has('verifyDesk.rosters.v1'), false);
  assert.equal(s.map.has('verifyDesk.thresholds.v1'), false);
});

test('localStorage: the legacy online opt-in is NEVER migrated (session-only by design)', () => {
  // verifyDesk.online.v1 recorded a network opt-in. Carrying it forward
  // would turn the network on without a fresh decision — the key is left
  // alone and no exhibitC.online.* key exists to write to.
  const s = memStorage({ 'verifyDesk.online.v1': 'true' });
  const migrated = migrateLocalStorage(s);
  assert.deepEqual(migrated, []);
  assert.equal(s.map.get('verifyDesk.online.v1'), 'true');
  assert.equal('online' in LS_KEYS, false);
});

test('localStorage: an existing exhibitC.* value wins; the legacy key is left alone', () => {
  const s = memStorage({
    'verifyDesk.rosters.v1': '[]',
    'exhibitC.rosters.v1': '[{"newsroom":"Newer"}]',
  });
  const migrated = migrateLocalStorage(s);
  assert.deepEqual(migrated, []);
  assert.equal(s.map.get(LS_KEYS.rosters), '[{"newsroom":"Newer"}]');
  assert.equal(s.map.get('verifyDesk.rosters.v1'), '[]'); // read-only fallback
});

test('localStorage: unknown legacy keys are never touched', () => {
  const s = memStorage({ 'verifyDesk.somethingElse.v9': '{"x":1}', 'unrelated.key': 'keep' });
  const migrated = migrateLocalStorage(s);
  assert.deepEqual(migrated, []);
  assert.equal(s.map.get('verifyDesk.somethingElse.v9'), '{"x":1}');
  assert.equal(s.map.get('unrelated.key'), 'keep');
});

test('localStorage: migration is idempotent', () => {
  const s = memStorage({ 'verifyDesk.thresholds.v1': '{"likely":5,"possible":9}' });
  migrateLocalStorage(s);
  const second = migrateLocalStorage(s);
  assert.deepEqual(second, []);
  assert.equal(s.map.get(LS_KEYS.thresholds), '{"likely":5,"possible":9}');
});

/* ------------------------------------------------------------------ */
/* CLI config dir                                                      */
/* ------------------------------------------------------------------ */

interface MemDir { files: Map<string, string> }

function memFs(dirs: Record<string, Record<string, string>>): { fsl: MigrateFs; tree: Map<string, MemDir> } {
  const tree = new Map<string, MemDir>();
  for (const [dir, files] of Object.entries(dirs)) tree.set(dir, { files: new Map(Object.entries(files)) });
  const fsl: MigrateFs = {
    existsSync: (p) => tree.has(p),
    mkdirSync: (p) => { if (!tree.has(p)) tree.set(p, { files: new Map() }); },
    readdirSync: (p) => {
      const d = tree.get(p);
      if (!d) throw new Error(`ENOENT: ${p}`);
      return [...d.files.keys()];
    },
    copyFileSync: (src, dest) => {
      const srcDir = path.dirname(src);
      const d = tree.get(srcDir);
      const content = d?.files.get(path.basename(src));
      if (content === undefined) throw new Error(`ENOENT: ${src}`);
      const destDir = path.dirname(dest);
      if (!tree.has(destDir)) tree.set(destDir, { files: new Map() });
      tree.get(destDir)!.files.set(path.basename(dest), content);
    },
  };
  return { fsl, tree };
}

test('CLI dir: legacy dir copied to ~/.exhibit-c, notice printed, legacy kept', () => {
  const home = '/home/test';
  const { fsl, tree } = memFs({
    [path.join(home, '.exhibit-desk')]: { 'desk-key.json': '{"v":1,"sk":"ab"}' },
  });
  const notices: string[] = [];
  const copied = migrateConfigDir(home, fsl, (m) => notices.push(m));
  assert.deepEqual(copied, ['desk-key.json']);
  assert.equal(tree.get(path.join(home, '.exhibit-c'))?.files.get('desk-key.json'), '{"v":1,"sk":"ab"}');
  // The legacy directory is NEVER deleted.
  assert.equal(tree.get(path.join(home, '.exhibit-desk'))?.files.get('desk-key.json'), '{"v":1,"sk":"ab"}');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /exhibit-c/);
});

test('CLI dir: no-op when the new dir already exists', () => {
  const home = '/home/test';
  const { fsl } = memFs({
    [path.join(home, '.exhibit-desk')]: { 'desk-key.json': 'old' },
    [path.join(home, '.exhibit-c')]: { 'desk-key.json': 'new' },
  });
  const notices: string[] = [];
  const copied = migrateConfigDir(home, fsl, (m) => notices.push(m));
  assert.deepEqual(copied, []);
  assert.deepEqual(notices, []);
});

test('CLI dir: no-op when there is no legacy dir', () => {
  const home = '/home/test';
  const { fsl } = memFs({});
  const copied = migrateConfigDir(home, fsl, () => { throw new Error('notice must not fire'); });
  assert.deepEqual(copied, []);
});
