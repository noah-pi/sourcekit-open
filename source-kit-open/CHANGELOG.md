# Changelog

Release notes are written per-milestone in `docs/` — see
`docs/RELEASE-0.8.0.md` through `docs/RELEASE-0.9.5.md` for the early
history. From 0.18.x onward, notable changes are listed here.

## Unreleased

- **X.509 verifier:** `verifyChain` gained an optional `requiredLeafEku`
  argument. The RFC 3161 path passes `id-kp-timeStamping`, so the TSA
  leaf's extended key usage is now honored inside chain verification (a
  critical `extKeyUsage` is enforced, not merely parsed) in addition to the
  existing explicit signer check. Other callers pass nothing and are
  unchanged.
- **Desk supply chain:** `desk/package-lock.json` regenerated against the
  public npm registry — the previous lockfile resolved every dependency
  against an internal mirror, which would fail `npm ci` on any external
  checkout and in CI.
- **c2pa-ios:** `Frameworks/FRAMEWORK-STORAGE.md` rewritten — the binary
  `C2PAC.xcframework` is an iOS-app build dependency sourced from upstream
  c2pa-swift, not part of the open core, and is not committed here.

## 0.18.4 — 2026-08-17

- **Stereo capture graph (app, 0.18.4):** the rear dual-camera path moved
  from two separate `AVCaptureDeviceInput`s to Apple's virtual
  dual-wide-device graph (one hardware-synchronized input; wide and
  ultra-wide constituent ports). The two-input graph is retained behind
  the `legacyMultiInputGraph` diagnostic flag. Motivation: on iPhone 17 /
  iOS 26 the multi-input graph degraded in the field — the ultra-wide
  stream never delivered a frame. On-device validation of the new graph is
  pending; the README carries the caveat.
- **Validation lab:** c2patool gold-standard checks now SKIP loudly
  (counted separately, excluded from the pass/fail tally) when c2patool is
  not installed, instead of failing. Affected suites: test-070-final,
  test-bmff-deid, test-identity, test-wifi.
- **Supply chain:** desk manifest realigned to the shared noble pins
  (curves 1.9.7, hashes 1.8.0 — same as the core and the staged lab);
  lockfile regenerated (was internally inconsistent — `npm ci` would have
  failed); nanoid now resolves 3.3.18 (GHSA-2v37-7h3g-55p8 range cleared).
- **Desk:** Content-Security-Policy added (`connect-src 'none'` — the
  desk's no-network guarantee is now enforced, not just stated).
- **Repo:** root manifest rewritten (dead script targets repointed to the
  staging flow, dependency list pruned to what the published core actually
  imports, `private` dropped); per-file authorship marker replaced with a
  pointer to `docs/PROVENANCE.md`; NOTICE, TRADEMARK.md, CITATION.cff,
  CONTRIBUTING.md added; LICENSE copyright line corrected; the retired
  `exhibit-desk` CLI shim removed (the migration of `~/.exhibit-desk`
  config directories remains).
- **Docs:** x509 verifier documents the deliberate pinned-root
  validity-window exemption; PIN lockout comment corrected
  (600k PBKDF2 iterations, not 60k) and its SecureStore entry now uses
  WHEN_UNLOCKED_THIS_DEVICE_ONLY like the passcode entry.
