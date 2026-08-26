// Source Kit 0.1.0 — File hashing and reading over expo-file-system
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * File hashing and reading over expo-file-system. Hashing is chunked (4 MiB)
 * so large videos never load into memory at once.
 *
 * readFileBytes loads whole files, including video and audio, at ~1.33x the
 * file size in base64 plus the decoded copy; a 200 MB clip peaks past 700 MB
 * in the JS heap and iOS kills the app. The UI's two-minute clip cap holds
 * this down.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { sha256 } from '@noble/hashes/sha256';
import { base64ToBytes, bytesToHex, bytesToBase64 } from './bytes';

const CHUNK = 4 * 1024 * 1024;

export async function hashFileSha256(uri: string): Promise<{ hex: string; bytes: number }> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) throw new Error('File does not exist');
  const size = info.size ?? 0;
  const hasher = sha256.create();
  let offset = 0;
  while (offset < size) {
    const length = Math.min(CHUNK, size - offset);
    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      position: offset,
      length,
    });
    hasher.update(base64ToBytes(b64));
    offset += length;
  }
  return { hex: bytesToHex(hasher.digest()), bytes: size };
}

export async function readFileBytes(uri: string): Promise<Uint8Array> {
  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return base64ToBytes(b64);
}

export async function writeFileBytes(uri: string, bytes: Uint8Array): Promise<void> {
  await FileSystem.writeAsStringAsync(uri, bytesToBase64(bytes), {
    encoding: FileSystem.EncodingType.Base64,
  });
}
