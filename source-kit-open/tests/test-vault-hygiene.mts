/**
 * Disclosure store hygiene.
 *
 * sealQueue writes documentDirectory/disclosure/{id}.json (per-item
 * disclosure state — the master seed until burn) and {id}.chunks.json (the
 * v2 chunk maps). An item delete that strands those files leaves the ONE
 * secret that can open withheld rungs behind after the item is gone. This
 * suite pins the real vaultFs code:
 *
 *   - deleteItem removes BOTH disclosure files (idempotent — absent is fine);
 *   - destroyVault removes the whole disclosure directory;
 *   - both operations are safe when the files never existed.
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-vault-hygiene.mts
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { deleteItem, destroyVault, sealVaultJson } from './vaultFs.mts';
import { documentDirectory } from './shim-fs.mts';
import * as SecureStore from './shim-secure-store.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};
const section = (t: string) => console.log(`\n— ${t} —`);

const p = (uri: string) => uri.replace('file://', '');
const DISC_DIR = `${documentDirectory}disclosure/`;
const VAULT_DIR = `${documentDirectory}vault/`;
const INDEX_FILE = `${VAULT_DIR}index.json`;

// A vault key in the shim keychain, so sealVaultJson runs the real seal path
// (never the passcode fallback).
await SecureStore.setItemAsync('verify_vault_key_v1', Buffer.from(crypto.randomBytes(32)).toString('base64'));

function seedItemWithDisclosure(id: string): void {
  fs.mkdirSync(p(DISC_DIR), { recursive: true });
  fs.mkdirSync(p(VAULT_DIR), { recursive: true });
  fs.writeFileSync(p(INDEX_FILE), JSON.stringify({
    items: [{ id, kind: 'video', createdAt: '2026-08-06T10:00:00.000Z', sha256: 'ab'.repeat(32), bytes: 1, mime: 'video/mp4', fingerprint: 'cd'.repeat(32), motionVerdict: null, hasLocation: false, phash: null }],
  }));
  fs.writeFileSync(p(`${VAULT_DIR}${id}.bin`), crypto.randomBytes(64));
}

async function writeDisclosureFiles(id: string): Promise<void> {
  fs.writeFileSync(p(`${DISC_DIR}${id}.json`), await sealVaultJson({ itemId: id, masterSeedHex: 'ef'.repeat(32), events: [] }));
  fs.writeFileSync(p(`${DISC_DIR}${id}.chunks.json`), await sealVaultJson({ video: { trackId: 'video', chunks: [] } }));
}

// ---------------------------------------------------------------------------
section('deleteItem takes the disclosure state + chunk maps with it (A-I-2)');

{
  seedItemWithDisclosure('item-hygiene');
  await writeDisclosureFiles('item-hygiene');
  check('fixture: both disclosure files exist',
    fs.existsSync(p(`${DISC_DIR}item-hygiene.json`)) && fs.existsSync(p(`${DISC_DIR}item-hygiene.chunks.json`)));
  await deleteItem('item-hygiene');
  check('deleteItem removes the disclosure state', !fs.existsSync(p(`${DISC_DIR}item-hygiene.json`)));
  check('deleteItem removes the chunk maps', !fs.existsSync(p(`${DISC_DIR}item-hygiene.chunks.json`)));
  check('deleteItem removes the item from the index',
    !JSON.parse(fs.readFileSync(p(INDEX_FILE), 'utf8')).items.some((i: { id: string }) => i.id === 'item-hygiene'));

  // Idempotence: deleting an item that never had disclosure files must not throw.
  seedItemWithDisclosure('item-no-disc');
  let threw = '';
  try { await deleteItem('item-no-disc'); } catch (e) { threw = (e as Error).message; }
  check('deleteItem is idempotent when the disclosure files are absent', threw === '', threw);
}

// ---------------------------------------------------------------------------
section('destroyVault removes the whole disclosure directory (A-I-2)');

{
  seedItemWithDisclosure('item-nuke');
  await writeDisclosureFiles('item-nuke');
  await destroyVault();
  check('destroyVault removes the disclosure directory', !fs.existsSync(p(DISC_DIR)));
  check('destroyVault removes the vault directory', !fs.existsSync(p(VAULT_DIR)));
  // Nuclear option is idempotent too.
  let threw = '';
  try { await destroyVault(); } catch (e) { threw = (e as Error).message; }
  check('destroyVault is safe to run twice', threw === '', threw);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
