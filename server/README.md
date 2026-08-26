<!-- Source Kit 0.1.0 — running the attestation relay -->
# Source Kit attestation relay

Verifies Apple App Attest statements and counts registrations. That is the
whole job. No media transits this server.

**The registry is an aggregate counter, not a device list.** The server keeps
`totalRegistrations` and nothing else — no keyIds, no key fingerprints, no
timestamps. `GET /` reports the count as `devices`.

- Rate limits key on the **attested keyId**, which cannot be counterfeited and
  is checked after verification. The client IP is a coarse pre-verification
  guard only: off Fly.io, `x-forwarded-for` is client-supplied and evadable, so
  front the server with a trustworthy proxy if you need a harder limit before
  verification.
- `server/state.json` and `server/registry.json` are runtime checkpoints.
  They are gitignored. Do not commit them.

## Deploy to Fly.io (about 5 minutes)

1. Install the CLI and sign in (once):
   ```sh
   curl -L https://fly.io/install.sh | sh
   fly auth login
   ```
2. From this directory (`server/`):
   ```sh
   fly launch --no-deploy        # creates the app; accept or edit the name
   fly volumes create verify_data --size 1 --region iad   # persists registry.json
   fly secrets set TEAM_ID=YOUR_APPLE_TEAM_ID             # your Apple Team ID
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
- `min_machines_running = 1` keeps one instance warm; on the pay-as-you-go
  tier this is a few dollars a month for a shared-cpu-1x 256MB machine.
- Custom domain: `fly certs add attest.yourdomain.org` plus one CNAME.

## Run locally instead

```sh
npm install
TEAM_ID=YOUR_APPLE_TEAM_ID node server.mjs     # http://localhost:8787
```
The phone and Mac must be on the same network; use the Mac's LAN IP in Settings.
