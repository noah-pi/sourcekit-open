<!-- Source Kit 0.1.0 — how to report a vulnerability -->
# Security Policy

Source Kit makes claims that are meant to be checked. If you find a
vulnerability, please tell us before it's public.

## Reporting

Report vulnerabilities through **GitHub Security Advisories** on this
repository ("Security" tab → "Report a vulnerability"). Advisories are
private by default: only the maintainers see them until we publish.

Please do not open a public issue for a vulnerability.

## What to include

- A **reproducible artifact**: a file (or generated fixture) that
  demonstrates the problem — e.g. an exhibit that verifies when it should
  not, or fails when it should verify. The suites in `tests/` show the
  shape of a good repro.
- The **app version** you tested against — Settings ▸ version line.
- What you expected the code to conclude, and what it actually concluded.

## Scope

In scope:

- The cryptographic claims: signature verification, X.509 chain anchoring,
  RFC 3161 timestamps, Apple App Attest verification, the PQ dual-signature
  layer, C2PA manifest parsing and embedding.
- The on-device vault (`src/vault/`): encryption at rest, key handling,
  plaintext cache hygiene.
- Roster and trust-list handling: signature checks, revocation timing,
  trust resolution.
- Verification of media, proof bundles and hash claims.

Out of scope: issues in third-party dependencies already tracked upstream.

## What to expect

This is a small beta project, maintained part-time. In plain terms:

- We **acknowledge within 7 days** and tell you whether we can reproduce it.
- We aim to **triage within 30 days** — confirmed, not-confirmed, or needs
  more information, said plainly.
- We fix confirmed vulnerabilities before the advisory goes public, and we
  credit reporters in the published advisory unless you ask us not to.
- There is **no bug bounty**. Reports are thanks-in-advance work, same as
  ours.
