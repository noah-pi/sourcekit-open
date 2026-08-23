// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Source Kit attestation relay (beta). Verifies Apple App Attest statements
 * and counts registrations. The registry is an aggregate counter only; no
 * per-device record is kept.
 *
 * Binding: Apple gives apps no direct access to App Attest keys, so clients
 * use emulated key attestation, where the clientDataHash is
 * SHA256(challenge ‖ signingPublicKey) and Apple's nonce extension certifies
 * it. This server re-derives that hash from the challenge it issued plus the
 * declared signing key and rejects anything that does not match the nonce
 * Apple signed into the leaf certificate.
 *
 * Endpoints:
 *   GET  /            → status
 *   GET  /challenge   → { challenge, expiresAt }   (single-use, 5 min TTL)
 *   POST /attest      → { challenge, attestation, signingPublicKey } → verifies
 *                       the Apple chain, app id, keyId binding, and the nonce
 *                       binding, then increments the registration counter
 *
 * Trust anchors and privacy:
 *   - The Apple App Attestation root CA is pinned on disk
 *     (apple-app-attest-root.pem) and never fetched, so a network attacker
 *     cannot substitute a root.
 *   - The leaf's nonce extension is parsed with a DER walk to OID
 *     1.2.840.113635.100.8.2, not a substring search.
 *   - No public device listing: GET /devices answers 404. Media verification
 *     is offline and does not need the registry.
 *
 * Config (env): PORT (default 8787), TEAM_ID (10-char Apple team id, required),
 * BUNDLE_ID (default com.verify.camera).
 *
 * Zero-framework: node:http + cbor-x. Run: TEAM_ID=XXXXXXXXXX node server.mjs
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { decode } from 'cbor-x';

const PORT = Number(process.env.PORT ?? 8787);
const TEAM_ID = process.env.TEAM_ID ?? '';
const BUNDLE_ID = process.env.BUNDLE_ID ?? 'com.verify.camera';
const APP_ID = `${TEAM_ID}.${BUNDLE_ID}`;
// On Fly.io set REGISTRY_FILE=/data/registry.json so the registry survives deploys (mounted volume).
const REGISTRY_FILE = process.env.REGISTRY_FILE ?? new URL('./registry.json', import.meta.url).pathname;
// Pinned Apple App Attestation root (DER, base64), embedded here rather than
// read from disk so the trust anchor does not depend on filesystem layout.
// The PEM in this repo is for human inspection only.
// Source: https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
// serial 0BF3BE0EF1CDD2E0FB8C6E721F621798 · DER SHA-256
// 1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932
const APPLE_ROOT_DER = Buffer.from(
  'MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0' +
  'YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa' +
  'Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBs' +
  'ZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh' +
  'NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9T' +
  'gS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw' +
  'CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4' +
  'xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganmrduC1bmTBGwD',
  'base64'
);

// --- tiny state ---
const challenges = new Map(); // base64 → expiresAt ms
// The registry is an aggregate counter, not a device list: no keyIds,
// fingerprints, or registration times are stored.
let registrations = 0;
try {
  const j = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  // An array-shaped registry file is collapsed to a count on read; its
  // entries are dropped.
  registrations = Array.isArray(j) ? j.length : (Number(j?.totalRegistrations) || 0);
} catch { /* first run */ }
const saveRegistry = () => fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ totalRegistrations: registrations }, null, 2));

// --- rate limiting (per-client fixed window; a burst can straddle an edge) ---
// Every endpoint is public and unauthenticated, so abuse control lives here.
const rateBuckets = new Map(); // key → { count, resetAt }
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; rateBuckets.set(key, b); }
  b.count += 1;
  stateDirty = true;
  return b.count > limit; // true = over the limit
}
// Bound the limiter map: drop expired windows every minute.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (b.resetAt <= now) rateBuckets.delete(k);
}, 60_000).unref();

// --- state persistence (challenges + rate buckets) ---
// Lives next to the registry on the mounted volume, so a redeploy does not
// hand out a fresh allowance or kill in-flight attestations. Writes are
// debounced (5s, dirty-flagged); the in-memory maps are the truth and the
// file is a best-effort checkpoint.
const STATE_FILE = process.env.STATE_FILE ?? REGISTRY_FILE.replace(/[^/]+$/, 'state.json');
let stateDirty = false;
function persistState() {
  if (!stateDirty) return;
  stateDirty = false;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      challenges: [...challenges],
      rateBuckets: [...rateBuckets],
    }));
  } catch { /* disk hiccup — in-memory state is unaffected */ }
}
{ // restore: skip anything already expired
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, exp] of s.challenges ?? []) if (exp > now) challenges.set(k, exp);
    for (const [k, b] of s.rateBuckets ?? []) if (b.resetAt > now) rateBuckets.set(k, b);
    // A forensicsGlobal field in a checkpoint is ignored.
  } catch { /* first run or fresh volume */ }
}
setInterval(persistState, 5_000).unref();
// Fly sends SIGTERM before a deploy; flush the checkpoint on the way out.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { stateDirty = true; persistState(); process.exit(0); });
}

function clientIp(req) {
  // Off Fly.io there is no trusted client-IP header: x-forwarded-for is
  // client-supplied and forgeable, so IP-keyed rate limits are only the
  // coarse pre-verification guard (the attested keyId is the primary key once
  // the attestation verifies; see /attest). A deployment needing a harder
  // pre-verification limit must front this server with a proxy that sets a
  // trustworthy client-IP header.
  return req.headers['fly-client-ip'] ?? req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.socket.remoteAddress ?? 'unknown';
}

/** Evict expired challenges (they're otherwise only removed on use). */
function sweepChallenges() {
  const now = Date.now();
  for (const [k, exp] of challenges) if (exp <= now) challenges.delete(k);
}

// --- minimal DER walking (for the Apple nonce extension) ---
// Node's X509Certificate verifies chain signatures but does not expose
// extensions, so the nonce is extracted with an explicit TLV walk to OID
// 1.2.840.113635.100.8.2.
const APPLE_NONCE_OID_HEX = '2a864886f763640802';
function readTlv(b, o) {
  if (!Number.isInteger(o) || o < 0 || o + 2 > b.length) throw new Error('DER: truncated');
  const tag = b[o];
  let len = b[o + 1];
  let p = o + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('DER: indefinite or oversized length');
    len = 0;
    // Multiply-accumulate, not (len << 8) | byte: JS bitwise ops are 32-bit
    // signed, so a 4-byte length ≥ 0x80000000 wraps negative, `next` points
    // backwards, and the walker hangs — a one-request remote DoS.
    for (let i = 0; i < n; i++) len = len * 256 + b[p + i];
    p += n;
  }
  if (p + len > b.length) throw new Error('DER: length overruns buffer');
  const next = p + len;
  if (next <= o) throw new Error('DER: non-advancing TLV'); // hard anti-hang invariant
  return { tag, content: b.subarray(p, next), next };
}
/** Returns the extnValue content for an extension OID, or null. */
function findExtension(certDer, oidHex) {
  const cert = readTlv(certDer, 0);
  const tbs = readTlv(cert.content, 0);
  let o = 0;
  let tlv = readTlv(tbs.content, o);
  if (tlv.tag === 0xa0) { o = tlv.next; tlv = readTlv(tbs.content, o); } // version
  o = tlv.next; // serial
  o = readTlv(tbs.content, o).next; // signature algid
  o = readTlv(tbs.content, o).next; // issuer
  o = readTlv(tbs.content, o).next; // validity
  o = readTlv(tbs.content, o).next; // subject
  o = readTlv(tbs.content, o).next; // spki
  while (o < tbs.content.length) {
    const opt = readTlv(tbs.content, o);
    o = opt.next;
    if (opt.tag !== 0xa3) continue; // [3] extensions
    const seq = readTlv(opt.content, 0);
    let eo = 0;
    while (eo < seq.content.length) {
      const ext = readTlv(seq.content, eo);
      eo = ext.next;
      const oid = readTlv(ext.content, 0);
      if (oid.content.toString('hex') !== oidHex) continue;
      let valOff = oid.next;
      const maybeBool = readTlv(ext.content, valOff);
      if (maybeBool.tag === 0x01) valOff = maybeBool.next;
      return readTlv(ext.content, valOff).content;
    }
  }
  return null;
}
/** The nonce is the unique 32-byte OCTET STRING inside context tag [1]. */
function extractNonceFromExtension(extnValue) {
  const found = [];
  const walk = (b, insideA1) => {
    let o = 0;
    while (o < b.length) {
      let tlv;
      try { tlv = readTlv(b, o); } catch { return; }
      o = tlv.next;
      if (tlv.tag === 0x04 && insideA1 && tlv.content.length === 32) found.push(tlv.content);
      else if (tlv.tag === 0xa1) walk(tlv.content, true);
      else if (tlv.tag === 0x30) walk(tlv.content, insideA1);
    }
  };
  walk(extnValue, false);
  return found.length === 1 ? found[0] : null;
}

const b64 = (buf) => Buffer.from(buf).toString('base64');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Verifies an App Attest attestation object against the expected
 * clientDataHash (for emulated key attestation: SHA256(challenge ‖
 * signingPublicKey), computed by the caller). Returns device info or throws.
 */
async function verifyAttestation(attestationBytes, clientDataHash) {
  const att = decode(new Uint8Array(attestationBytes));
  if (att.fmt !== 'apple-appattest') throw new Error('not an apple-appattest statement');
  const { x5c } = att.attStmt;
  if (!Array.isArray(x5c) || x5c.length < 2) throw new Error('missing x5c chain');
  // attStmt.receipt is neither required nor stored: it is only useful to a
  // server running Apple's receipt-based fraud-metric flow, which this one
  // does not.

  const leafDer = Buffer.from(x5c[0]);
  const chain = x5c.map((c) => new crypto.X509Certificate(Buffer.from(c)));
  const root = new crypto.X509Certificate(APPLE_ROOT_DER); // pinned, never fetched

  // 1. Chain: leaf → intermediate(s) → Apple root.
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i].verify(chain[i + 1].publicKey)) throw new Error(`cert ${i} not signed by ${i + 1}`);
  }
  if (!chain[chain.length - 1].verify(root.publicKey)) throw new Error('chain not rooted at Apple App Attest CA');

  // 2. Validity window.
  const now = new Date();
  for (const c of chain) {
    if (now < new Date(c.validFrom) || now > new Date(c.validTo)) throw new Error('certificate outside validity window');
  }

  // 3. authData: rpIdHash = SHA256(appId); parse attested credential data.
  const authData = Buffer.from(att.authData);
  if (authData.length < 37) throw new Error('authData too short');
  const rpIdHash = authData.subarray(0, 32);
  if (!rpIdHash.equals(sha256(Buffer.from(APP_ID)))) {
    throw new Error(`app id mismatch (expected rpIdHash for ${APP_ID})`);
  }
  const flags = authData[32];
  if (!(flags & 0x40)) throw new Error('attested credential data flag not set');
  // attested credential data: aaguid(16) | credIdLen(2) | credId | credPublicKey(CBOR)
  const credIdLen = authData.readUInt16BE(53);
  const credId = authData.subarray(55, 55 + credIdLen);
  const credPubKeyCbor = authData.subarray(55 + credIdLen);
  const credKey = decode(new Uint8Array(credPubKeyCbor)); // COSE_Key: {1:2, 3:-7, -1:1, -2:x, -3:y}
  const get = (m, k) => (m instanceof Map ? m.get(k) : m[String(k)]);
  const x = get(credKey, -2), y = get(credKey, -3);
  if (!x || !y || x.length !== 32 || y.length !== 32) throw new Error('bad credential public key');
  const publicKey = Buffer.concat([Buffer.from([0x04]), Buffer.from(x), Buffer.from(y)]);

  // 3a. aaguid identifies the authenticator: Apple App Attest production
  // ("appattest"+zeros) or development ("appattestdevelop").
  const aaguid = authData.subarray(37, 53);
  const AAGUID_PROD = Buffer.concat([Buffer.from('appattest', 'ascii'), Buffer.alloc(7)]);
  const AAGUID_DEV = Buffer.from('appattestdevelop', 'ascii');
  const attestationEnv = aaguid.equals(AAGUID_PROD) ? 'production' : aaguid.equals(AAGUID_DEV) ? 'development' : null;
  if (!attestationEnv) throw new Error('unrecognized aaguid — not an Apple App Attest authenticator');

  // 3b. Credential ID = SHA-256 of the credential public key (Apple's
  // construction), so authData must be internally consistent.
  if (!credId.equals(sha256(publicKey))) {
    throw new Error('credential ID is not SHA-256 of the credential public key');
  }

  // 3c. The leaf certificate's public key must be the attested credential
  // key: this binds the x5c chain to this authData and blocks mixing two
  // genuine attestations.
  const leafJwk = chain[0].publicKey.export({ format: 'jwk' });
  if (leafJwk.x !== b64url(x) || leafJwk.y !== b64url(y)) {
    throw new Error('attestation certificate key does not match the attested credential key');
  }

  // 4. keyId binding: keyId = base64url(SHA256(publicKey)).
  const keyId = b64url(sha256(publicKey));

  // 5. Nonce binding: leaf cert extension 1.2.840.113635.100.8.2 holds
  //    SHA256(authData || clientDataHash). Since the clientDataHash binds the
  //    app's own signing key, the attestation covers that specific key.
  const expectedNonce = sha256(Buffer.concat([authData, clientDataHash]));
  const extValue = findExtension(leafDer, APPLE_NONCE_OID_HEX);
  if (!extValue) throw new Error('Apple nonce extension missing from the attestation certificate');
  const nonce = extractNonceFromExtension(extValue);
  if (!nonce) throw new Error('could not parse a unique nonce from the Apple nonce extension');
  if (!nonce.equals(expectedNonce)) {
    throw new Error('nonce mismatch — attestation is not bound to the declared signing key');
  }

  return { keyId, publicKeyBase64: b64(publicKey), attestationBase64: b64(attestationBytes), attestationEnv };
}

// --- HTTP ---
const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(obj));
  };
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === 'OPTIONS') { send(204, {}); return; }

    if (req.method === 'GET' && url.pathname === '/') {
      send(200, { service: 'verify-attestation', appId: TEAM_ID ? APP_ID : '(TEAM_ID not set)', devices: registrations });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/challenge') {
      if (rateLimited(`challenge:${clientIp(req)}`, 30, 10 * 60_000)) { send(429, { error: 'rate limit exceeded' }); return; }
      if (challenges.size > 500) sweepChallenges();
      if (challenges.size > 10_000) { send(503, { error: 'server busy — try again shortly' }); return; }
      const challenge = crypto.randomBytes(32);
      const key = b64(challenge);
      challenges.set(key, Date.now() + 5 * 60_000);
      stateDirty = true;
      send(200, { challenge: key });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/attest') {
      // Coarse pre-verification guard keyed on the spoofable client IP (see
      // clientIp). Looser than the per-key limit below; it bounds verification
      // work rather than limiting identities.
      if (rateLimited(`attest:${clientIp(req)}`, 60, 10 * 60_000)) { send(429, { error: 'rate limit exceeded' }); return; }
      const body = await new Promise((resolve, reject) => {
        let d = '';
        let killed = false;
        req.on('data', (c) => {
          d += c;
          // Attestations are a few KB. Destroy with an error so this promise
          // rejects instead of dangling on the dead socket.
          if (d.length > 2_000_000 && !killed) { killed = true; req.destroy(new Error('body too large')); }
        });
        // Malformed JSON returns a clean 400 rather than crashing the process.
        req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({ __malformed: true }); } });
        req.on('error', reject);
      }).catch(() => null);
      if (body === null) { try { send(413, { error: 'request body too large or unreadable' }); } catch { /* socket already gone */ } return; }
      if (body.__malformed) { send(400, { error: 'request body is not valid JSON' }); return; }
      const { challenge, attestation, signingPublicKey } = body;
      const exp = challenges.get(challenge);
      challenges.delete(challenge); // single use
      stateDirty = true;
      if (!exp || exp < Date.now()) { send(400, { error: 'unknown or expired challenge' }); return; }
      // Signing key this attestation binds to: uncompressed P-256 point
      // (65 bytes, 0x04 prefix), as SecKeyCopyExternalRepresentation emits.
      const signingPub = Buffer.from(typeof signingPublicKey === 'string' ? signingPublicKey : '', 'base64');
      if (signingPub.length !== 65 || signingPub[0] !== 0x04) {
        send(400, { error: 'signingPublicKey must be a base64 uncompressed P-256 point (65 bytes)' });
        return;
      }
      // Emulated key attestation: re-derive the client's clientDataHash,
      // SHA256(challenge ‖ signingPublicKey), and require Apple's nonce to
      // match it. The attestation must be a base64 string of bounded length:
      // Buffer.from(n) on a numeric JSON field allocates n bytes, so a small
      // POST could otherwise force a huge allocation.
      if (typeof attestation !== 'string' || attestation.length === 0 || attestation.length > 2_000_000) {
        send(400, { error: 'attestation must be a base64 string (a few KB)' });
        return;
      }
      const clientDataHash = sha256(Buffer.concat([Buffer.from(challenge, 'base64'), signingPub]));
      const device = await verifyAttestation(Buffer.from(attestation, 'base64'), clientDataHash);
      // Primary rate limit, keyed on the attested keyId: source IPs rotate
      // but keyIds must verify against Apple's root first. Only checkable
      // post-verification, hence the coarse IP bucket above.
      if (rateLimited(`attest:key:${device.keyId}`, 20, 10 * 60_000)) { send(429, { error: 'rate limit exceeded' }); return; }
      const fingerprint = sha256(signingPub).toString('hex');
      const entry = {
        ...device,
        signingPublicKeyBase64: b64(signingPub),
        fingerprint,
        registeredAt: new Date().toISOString(),
      };
      // Nothing per-device is stored; the registry is a counter.
      registrations += 1;
      saveRegistry();
      send(200, { ok: true, device: entry });
      return;
    }

    // No /devices listing: a public log of attested-device fingerprints and
    // registration times is an opsec hazard, and verification is offline.
    if (req.method === 'GET' && url.pathname === '/devices') {
      send(404, { error: 'not found' });
      return;
    }

    send(404, { error: 'not found' });
  } catch (e) {
    send(400, { error: String(e.message ?? e) });
  }
});

server.listen(PORT, () => {
  console.log(`verify-attestation server on :${PORT}`);
  if (!TEAM_ID) console.warn('WARNING: TEAM_ID not set — /attest will reject every app id');
});
