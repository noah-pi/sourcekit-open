import * as fs from 'node:fs';
export const EncodingType = { Base64: 'base64' };
export const documentDirectory = '/tmp/lab/fs/';
export const cacheDirectory = '/tmp/lab/fs/';
const path = (uri: string) => uri.replace('file://', '');
export async function getInfoAsync(uri: string) {
  try { const s = fs.statSync(path(uri)); return { exists: true, size: s.size, isDirectory: s.isDirectory() }; }
  catch { return { exists: false, size: 0, isDirectory: false }; }
}
export async function readAsStringAsync(uri: string, opts?: { encoding?: string }) {
  const buf = fs.readFileSync(path(uri));
  return opts?.encoding === EncodingType.Base64 ? buf.toString('base64') : buf.toString('utf8');
}
export async function writeAsStringAsync(uri: string, data: string, opts?: { encoding?: string }) {
  fs.mkdirSync('/tmp/lab/fs', { recursive: true });
  fs.writeFileSync(path(uri), opts?.encoding === EncodingType.Base64 ? Buffer.from(data, 'base64') : data);
}
// expo deleteAsync removes files AND directories (recursively); idempotent
// swallows a missing path. The lab mirrors that — vaultFs's destroyVault
// relies on recursive directory removal.
export async function deleteAsync(uri: string) { try { fs.rmSync(path(uri), { recursive: true, force: true }); } catch {} }
export async function makeDirectoryAsync(uri: string) { fs.mkdirSync(path(uri), { recursive: true }); }
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
