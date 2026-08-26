<!-- Source Kit 0.1.0 — building and running the app -->
# Building the app — the values you must supply

Building and submitting your own copy takes four values. None of them is in
this repository; you supply your own.

| Value | What it is | Where it goes |
|---|---|---|
| EAS project ID | The ID of your Expo project — `eas init` creates it | Written into `app.json` at `expo.extra.eas.projectId` by `eas init` |
| Apple Team ID | 10-character Apple Developer Team ID (developer.apple.com → Membership details) | `eas.json` → `submit.production.ios.appleTeamId`, or `--apple-team-id` |
| ASC app ID | App Store Connect app ID (App Store Connect → your app → App Information → "Apple ID") | `eas.json` → `submit.production.ios.ascAppId`, or `--asc-app-id` |
| Apple ID | The Apple account that submits the build | `eas.json` → `submit.production.ios.appleId`, or `--apple-id` |

## Before the first build

The C2PA Rust core is not committed. Fetch it once:

```sh
./scripts/fetch-c2pa-framework.sh
```

It downloads the release zip from contentauth/c2pa-swift, verifies it against
the SHA-256 pinned in upstream's own `Package.swift`, and unpacks the two iOS
slices into `modules/c2pa-ios/ios/Frameworks/`. About 387 MB, once. The result
has to be on disk before `eas build` — the upload includes it.

## How to supply them

**Option A — a local `eas.json`.** `eas build` creates one on first run. Fill
the three `submit.production.ios` values into your working copy and keep the
change out of commits (`git update-index --skip-worktree eas.json`). Run
`eas init` once so the project ID lands in `app.json`.

**Option B — one-liner, nothing written to disk:**

```sh
eas init   # once — creates your EAS project and writes its projectId
eas build --platform ios --profile production
eas submit --platform ios --profile production \
  --apple-id you@example.com \
  --asc-app-id 1234567890 \
  --apple-team-id ABCDEFGHIJ
```

Note: App Attest verification is keyed to the Team ID baked into the build
(`VERIFY_APPLE_APP_ID` in `src/lib/appleAttestRoot.ts`) — a fork must set
its own Team ID there too, or attestations will (correctly) fail the app-id
check.
