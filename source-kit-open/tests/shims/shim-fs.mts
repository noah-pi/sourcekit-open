// Written with AI assistance. Verification: docs/PROVENANCE.md.

import * as fs from 'node:fs';
export const EncodingType = { Base64: 'base64' };
export const documentDirectory = '/tmp/lab/fs/';
export const cacheDirectory = '/tmp/lab/fs/';
const path = (uri: string) => uri.replace('file://', '');
export async function getInfoAsync(uri: string) {
  try { const s = fs.statSync(path(uri)); return { exists: true, size: s.size, isDirectory: s.isDirectory() }; }
  catch { return { exists: false, size: 0, isDirectory: false }; }
}
export async function readAsStringAsync(uri: string, opts?: { encoding?: string; position?: number; length?: number }) {
  // position/length are the chunked-read contract fileHash.ts relies on —
  // implement them for real: a lab that silently returned the whole file
  // per chunk would be testing a hash nobody verifies.
  const buf = fs.readFileSync(path(uri));
  const slice = (opts?.position !== undefined || opts?.length !== undefined)
    ? buf.subarray(opts.position ?? 0, opts.length !== undefined ? (opts.position ?? 0) + opts.length : undefined)
    : buf;
  return opts?.encoding === EncodingType.Base64 ? slice.toString('base64') : slice.toString('utf8');
}
export async function writeAsStringAsync(uri: string, data: string, opts?: { encoding?: string }) {
  fs.mkdirSync('/tmp/lab/fs', { recursive: true });
  fs.writeFileSync(path(uri), opts?.encoding === EncodingType.Base64 ? Buffer.from(data, 'base64') : data);
}
// expo deleteAsync removes files AND directories (recursively); idempotent
// swallows a missing path. The lab mirrors that — vaultFs's destroyVault
// relies on recursive directory removal.
export async function deleteAsync(uri: string, _opts?: { idempotent?: boolean }) { try { fs.rmSync(path(uri), { recursive: true, force: true }); } catch {} }
export async function makeDirectoryAsync(uri: string, _opts?: { intermediates?: boolean }) { fs.mkdirSync(path(uri), { recursive: true }); }
// expo moveAsync renames atomically on APFS; vaultFs's atomic index write
// (tmp + rename) relies on it. fs.renameSync mirrors the semantics.
export async function moveAsync(opts: { from: string; to: string }) {
  fs.mkdirSync(path(opts.to).replace(/\/[^/]*$/, ''), { recursive: true });
  fs.renameSync(path(opts.from), path(opts.to));
}
// expo readDirectoryAsync lists entry names (not paths); vaultFs's
// rebuildIndexFromRecords scans the vault dir for *.att.json with it.
export async function readDirectoryAsync(uri: string) {
  return fs.readdirSync(path(uri));
}
