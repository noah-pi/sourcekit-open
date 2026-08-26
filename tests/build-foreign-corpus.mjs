#!/usr/bin/env node
// Source Kit 0.1.0 — media signed by another producer
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Rebuilds tests/corpus/foreign/ — media signed by another producer.
 *
 * c2patool is the C2PA reference implementation. Signing with it, its sample
 * ES256 chain, and its own claim generator produces manifests this codebase
 * had no hand in, which is the only way to test the reader against a stranger.
 *
 * Usage:  node tests/build-foreign-corpus.mjs
 * Needs:  c2patool on PATH or at $C2PATOOL, ffmpeg for the source frames.
 *
 * The output is committed, so the suite runs with neither tool installed.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'corpus', 'foreign');
const tool = process.env.C2PATOOL ?? 'c2patool';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-'));

// The sample chain ships beside the binary. C2PATOOL_SAMPLE points at it when
// the binary is not inside its own release directory.
const sample = process.env.C2PATOOL_SAMPLE
  ?? path.join(path.dirname(execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()), 'sample');
for (const f of ['es256_private.key', 'es256_certs.pem']) {
  if (!fs.existsSync(path.join(sample, f))) {
    console.error(`c2patool sample chain not found at ${sample} (set C2PATOOL_SAMPLE)`);
    process.exit(1);
  }
}

const manifest = (claimVersion) => JSON.stringify({
  claim_version: claimVersion,
  // No ta_url: a timestamp authority would make the fixtures non-reproducible
  // and require the network to rebuild them.
  claim_generator_info: [{ name: 'TestApp', version: '1.0.0' }],
  title: `Foreign v${claimVersion}`,
  assertions: [
    { label: 'stds.schema-org.CreativeWork',
      data: { '@context': 'https://schema.org', '@type': 'CreativeWork',
              author: [{ '@type': 'Person', name: 'Joe Bloggs' }] } },
    { label: 'c2pa.actions', data: { actions: [{ action: 'c2pa.created' }] } },
  ],
}, null, 2);

const env = {
  ...process.env,
  C2PA_PRIVATE_KEY: fs.readFileSync(path.join(sample, 'es256_private.key'), 'utf8'),
  C2PA_SIGN_CERT: fs.readFileSync(path.join(sample, 'es256_certs.pem'), 'utf8'),
};

const frame = (ext) => {
  const p = path.join(work, `src.${ext}`);
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i',
    'testsrc=duration=1:size=320x240:rate=1', '-frames:v', '1', p], { stdio: 'ignore' });
  return p;
};

/** BMFF sources: the container the app's own video and audio captures use. */
const clip = () => {
  const p = path.join(work, 'src.mp4');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i',
    'testsrc=duration=1:size=320x240:rate=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p],
    { stdio: 'ignore' });
  return p;
};
const tone = () => {
  const p = path.join(work, 'src.m4a');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=2', '-c:a', 'aac', p], { stdio: 'ignore' });
  return p;
};

const sign = (src, claimVersion, dest) => {
  const mPath = path.join(work, `m${claimVersion}.json`);
  fs.writeFileSync(mPath, manifest(claimVersion));
  execFileSync(tool, [src, '-m', mPath, '-o', path.join(out, dest), '-f'], { env, stdio: 'ignore' });
  console.log(`  ${dest}`);
};

fs.mkdirSync(out, { recursive: true });
const jpg = frame('jpg'), png = frame('png');
sign(jpg, 1, 'c2patool-v1.jpg');
sign(jpg, 2, 'c2patool-v2.jpg');
sign(png, 2, 'c2patool-v2.png');
sign(clip(), 1, 'c2patool-v1.mp4');
sign(tone(), 1, 'c2patool-v1.m4a');

// One byte flipped deep in the compressed scan, well past any manifest
// segment: the claim is untouched, so the signature still verifies and only
// the media re-hash fails.
const bytes = fs.readFileSync(path.join(out, 'c2patool-v2.jpg'));
bytes[bytes.length - 2000] ^= 0xff;
fs.writeFileSync(path.join(out, 'c2patool-v2-tampered.jpg'), bytes);
console.log('  c2patool-v2-tampered.jpg');

fs.rmSync(work, { recursive: true, force: true });
console.log(`\nforeign corpus rebuilt in ${out}`);
