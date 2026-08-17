# Building the app — the values you must supply

The full app tree (exhibit-app) ships with **placeholder** Apple submission
credentials in `eas.json`. Earlier revisions committed a personal Apple ID,
App Store Connect app ID, and Team ID there; those are gone. To build and
submit your own copy you supply four values:

| Value | What it is | Where it goes |
|---|---|---|
| EAS project ID | The ID of YOUR Expo project — `eas init` creates it | Written into `app.json` at `expo.extra.eas.projectId` by `eas init` |
| Apple Team ID | 10-character Apple Developer Team ID (developer.apple.com → Membership details) | `eas.json` → `submit.production.ios.appleTeamId`, or `--apple-team-id` |
| ASC app ID | App Store Connect app ID (App Store Connect → your app → App Information → "Apple ID") | `eas.json` → `submit.production.ios.ascAppId`, or `--asc-app-id` |
| Apple ID | The Apple account that submits the build | `eas.json` → `submit.production.ios.appleId`, or `--apple-id` |

## How to supply them

**Option A — local eas.json edit.** Fill the three `submit.production.ios`
values into your working copy's `eas.json` and do not commit the change
(`git update-index --skip-worktree eas.json` keeps it out of accidental
commits). Run `eas init` once so the project ID lands in `app.json`.

**Option B — one-liner, nothing written to disk:**

```sh
eas init   # once — creates YOUR EAS project and writes its projectId
eas build --platform ios --profile production
eas submit --platform ios --profile production \
  --apple-id you@example.com \
  --asc-app-id 1234567890 \
  --apple-team-id ABCDEFGHIJ
```

The committed `eas.json` keeps `__SET_VIA_EAS_SUBMIT_*__` placeholders so a
forgotten override fails loudly at submit time instead of silently shipping
someone else's identity.

Note: App Attest verification is keyed to the Team ID baked into the build
(`VERIFY_APPLE_APP_ID` in `src/lib/appleAttestRoot.ts`) — a fork must set
its own Team ID there too, or attestations will (correctly) fail the app-id
check.
