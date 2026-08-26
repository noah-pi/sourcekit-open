// Source Kit 0.1.0 — filesystem shim for the lab
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
  // position/length implement the chunked-read contract fileHash.ts relies
  // on; returning the whole file per chunk would invalidate the hash tests.
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
// expo deleteAsync removes files and directories recursively and swallows a
// missing path when idempotent; vaultFs's destroyVault needs that.
export async function deleteAsync(uri: string, _opts?: { idempotent?: boolean }) { try { fs.rmSync(path(uri), { recursive: true, force: true }); } catch {} }
export async function makeDirectoryAsync(uri: string, _opts?: { intermediates?: boolean }) { fs.mkdirSync(path(uri), { recursive: true }); }
// expo moveAsync renames atomically on APFS, which vaultFs's atomic index
// write (tmp + rename) relies on. fs.renameSync mirrors it.
export async function moveAsync(opts: { from: string; to: string }) {
  fs.mkdirSync(path(opts.to).replace(/\/[^/]*$/, ''), { recursive: true });
  fs.renameSync(path(opts.from), path(opts.to));
}
// expo readDirectoryAsync lists entry names, not paths; vaultFs's
// rebuildIndexFromRecords scans for *.att.json with it.
export async function readDirectoryAsync(uri: string) {
  return fs.readdirSync(path(uri));
}
