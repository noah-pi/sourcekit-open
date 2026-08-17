# Source Kit attestation relay

Verifies Apple App Attest statements and counts registrations. Since
0.9.5 this is the server's ONLY job — the Google Vision reverse-image route
was removed (with its app client), so no media ever transits this server.

**The registry is an aggregate counter, not a device list.** Earlier
versions stored every attested keyId, signing-key fingerprint, and
registration time forever — write-only data nothing ever read, and a
permanent roster of real hardware on disk. Post-audit, the server keeps
only `totalRegistrations` (an old registry file collapses to its count on
first read; the entries are dropped). `GET /` still reports the count as
`devices`.

Other post-audit hardening:
- The App Attest `receipt` field is no longer required or stored — Apple
  receipts only pay off with the server-side fraud-metric flow, which this
  server does not run.
- Rate limits key on the **attested keyId** (uncounterfeitable, checked
  after verification) with the client IP as a coarse pre-verification
  guard only. Off Fly.io, `x-forwarded-for` is client-supplied, so the IP
  guard alone is evadable — front the server with a trustworthy proxy if
  you need a harder pre-verification limit.
- `server/state.json` and `server/registry.json` are runtime checkpoints —
  gitignored, never commit them.

## Deploy to Fly.io (about 5 minutes)

1. Install the CLI and sign in (once):
   ```sh
   curl -L https://fly.io/install.sh | sh
   fly auth login
   ```
2. From THIS directory (`exhibit-app/server/`):
   ```sh
   fly launch --no-deploy        # creates the app; accept or edit the name
   fly volumes create verify_data --size 1 --region iad   # persists registry.json
   fly secrets set TEAM_ID=YOUR_APPLE_TEAM_ID                     # your Apple Team ID
   fly deploy
   ```
3. Your server is live at `https://<your-app-name>.fly.dev` — test with:
   ```sh
   curl https://<your-app-name>.fly.dev/        # {"ok":true,...}
   ```
4. In the Source Kit app: Settings → Attestation server → paste that URL →
   "Attest this device".

Notes:
- TEAM_ID must be your 10-character Apple Developer Team ID or every
  attestation is rejected.
- The registry counter lives on the `verify_data` volume at
  /data/registry.json (env `REGISTRY_FILE` in fly.toml). Without the volume,
  a redeploy resets the count.
- `min_machines_running = 1` keeps one instance warm; on the free/pay-as-you-go
  tier this is a few dollars a month for a shared-cpu-1x 256MB machine.
- Custom domain later: `fly certs add attest.yourdomain.org` + one CNAME.

## Run locally instead

```sh
npm install
TEAM_ID=YOUR_APPLE_TEAM_ID node server.mjs     # http://localhost:8787
```
(The phone and Mac must be on the same network; use the Mac's LAN IP in Settings.)

## Removed in 0.9.5: the forensic lookup route

`POST /forensics/web` (a Google Cloud Vision reverse-image proxy) was
removed — the only feature that sent media off the device and the only one
with a recurring bill. If you're running an older app build against this
server, its "online check" button will simply report unavailability; every
cryptographic check is unaffected. The `GOOGLE_VISION_KEY` secret can be
deleted (`fly secrets unset GOOGLE_VISION_KEY`).
