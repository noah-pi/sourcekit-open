// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * CLI report signing key.
 *
 * A CLI-side P-256 software key, generated on first use and stored at
 * ~/.exhibit-c/desk-key.json (mode 0600; the pre-rename ~/.exhibit-desk
 * directory is migrated by migrateConfigDir — copied, never deleted). It
 * signs batch reports so the operator can pin this CLI's fingerprint in
 * their own records and detect report tampering in transit.
 *
 * HONESTY: this is a SOFTWARE key on a general-purpose computer — it proves
 * a report was produced by whoever controls this key, nothing more.
 * It is not a hardware anchor and never vouches for the truth of a capture;
 * the report's own per-item limits still apply.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from '@exhibit/lib/bytes';
import { canonicalize } from '@exhibit/lib/canonical';

export interface DeskKey {
  secretKey: Uint8Array;
  publicKey: Uint8Array; // 65-byte uncompressed point
  fingerprint: string;   // sha256 hex of the public key
  createdAt: string;
}

const KEY_DIR = path.join(os.homedir(), '.exhibit-c');
const KEY_FILE = path.join(KEY_DIR, 'desk-key.json');

/** The fs surface migrateConfigDir needs — injected so tests can mock it. */
export interface MigrateFs {
  existsSync(p: string): boolean;
  mkdirSync(p: string, opts?: { recursive?: boolean; mode?: number }): unknown;
  readdirSync(p: string): string[];
  copyFileSync(src: string, dest: string): unknown;
}

/**
 * Config-dir rename migration (ARCHITECTURE §7): if ~/.exhibit-c does not
 * exist and ~/.exhibit-desk does, copy the legacy files over and say so in
 * one line. The legacy directory is NEVER deleted. Returns the file names
 * copied (empty when there was nothing to do).
 */
export function migrateConfigDir(home: string, fsl: MigrateFs, notice: (msg: string) => void): string[] {
  const next = path.join(home, '.exhibit-c');
  const prev = path.join(home, '.exhibit-desk');
  if (fsl.existsSync(next) || !fsl.existsSync(prev)) return [];
  fsl.mkdirSync(next, { recursive: true, mode: 0o700 });
  const copied: string[] = [];
  for (const name of fsl.readdirSync(prev)) {
    fsl.copyFileSync(path.join(prev, name), path.join(next, name));
    copied.push(name);
  }
  notice(`exhibit-c: copied CLI config (${copied.length} file(s)) from ~/.exhibit-desk to ~/.exhibit-c — the old directory was left in place.`);
  return copied;
}

export function getOrCreateDeskKey(): DeskKey {
  try {
    const raw = fs.readFileSync(KEY_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j?.v === 1 && typeof j.sk === 'string') {
      const secretKey = hexToBytes(j.sk);
      const publicKey = p256.getPublicKey(secretKey, false);
      return { secretKey, publicKey, fingerprint: bytesToHex(sha256(publicKey)), createdAt: j.createdAt };
    }
  } catch { /* absent or unreadable → generate */ }

  const secretKey = p256.utils.randomPrivateKey();
  const publicKey = p256.getPublicKey(secretKey, false);
  const createdAt = new Date().toISOString();
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, JSON.stringify({ v: 1, sk: bytesToHex(secretKey), createdAt }), { mode: 0o600 });
  return { secretKey, publicKey, fingerprint: bytesToHex(sha256(publicKey)), createdAt };
}

/**
 * Signs the canonical JSON of a report object (minus any `signer` field).
 * Returns the signer block to attach.
 */
export function signReport(reportWithoutSigner: object, key: DeskKey): {
  alg: 'ES256';
  publicKeyBase64: string;
  fingerprint: string;
  signature: string; // DER, base64
} {
  const payload = new TextEncoder().encode(canonicalize(reportWithoutSigner as never));
  const sig = p256.sign(sha256(payload), key.secretKey, { lowS: true }).toDERRawBytes();
  return {
    alg: 'ES256',
    publicKeyBase64: bytesToBase64(key.publicKey),
    fingerprint: key.fingerprint,
    signature: bytesToBase64(sig),
  };
}

/** Verifies a signed desk report — used by the CLI's own self-test. */
export function verifyReportSignature(report: { signer?: { publicKeyBase64: string; signature: string } } & object): boolean {
  const signer = report.signer;
  if (!signer) return false;
  const { signer: _drop, ...rest } = report as Record<string, unknown>;
  const payload = new TextEncoder().encode(canonicalize(rest as never));
  try {
    return p256.verify(base64ToBytes(signer.signature), sha256(payload), base64ToBytes(signer.publicKeyBase64), { lowS: true });
  } catch {
    return false;
  }
}
