# WS3 — iOS Upstream C2PA Integration (modules/c2pa-ios)

**Status:** delivered as new files + this patch list. **Nothing in the existing
tree was modified** — every config change below is for the main agent to apply.
Basis: SPEC-WS3-Upstream.md §1/§2, WS3-Binding-Path.md §2/§7a (approved
2026-08-06).

## 0. What was delivered

| File | What |
|---|---|
| `modules/c2pa-ios/expo-module.config.json` | Expo module registration (iOS-only, module class `C2paIosModule`) — identical shape to `modules/capture-kit/` |
| `modules/c2pa-ios/ios/C2paIos.podspec` | Podspec, iOS 16.0 floor, `Security` framework — identical pattern to siblings |
| `modules/c2pa-ios/ios/C2paIosModule.swift` | The Swift module: `getVersion`, `loadSettings`, `readManifest`, `readManifestDetached`, `signFilePem`, `signFileSecureEnclave` |
| `src/provenance/engine/upstreamEngineIos.ts` | TS bridge producing the SAME `NormalizedEngineResult` as the desk's `upstreamEngine.ts` — feeds the shared policy layer unchanged |
| `docs/WS3-IOS-INTEGRATION.md` | This file |

### Key finding (resolves WS3-Binding-Path unknown §9.2)

**c2pa-swift v0.0.12 DOES expose c2pa-rs global settings** — `Signer.loadSettings(_:format:)` (static, JSON or TOML, verified in the tagged source at `Library/Sources/Signer.swift:266`). On-device trust-configured reading (pinned trust anchors, `verify_trust`, OCSP/remote-fetch disabled) is therefore possible WITHOUT dropping to the C API. The TS bridge uses exactly the desk engine's settings JSON shape. Remaining sub-caveat: which c2pa-rs version v0.0.12 pins is still unstated upstream (§9.1), so settings KEY compatibility rests on the shared c2pa-rs settings model, not on a version guarantee — flagged in §4.

Also resolved by source inspection: **Ed25519 IS in the `SigningAlgorithm` enum**
(`Library/Sources/SigningAlgorithm.swift`) — narrows §9.8 to "supported via PEM
signers; not Secure Enclave (hardware is P-256/ES256 only)".

## 1. Module layout & design decisions

- **No verdicts on device, ever.** The Swift module returns the upstream store
  JSON string verbatim and throws engine errors with the raw c2pa-rs message
  text preserved (`C2PAError.errorDescription` = `"C2PA API error: <raw>"`,
  carried to JS by a `NamedException` — same SDK-57 reason-propagation fix as
  CaptureKit). The TS bridge sorts codes/messages into facts; the policy layer
  (synced from sourcekit-open) is the sole verdict authority.
- **Normalization is verbatim from the desk engine** (status-code classes,
  ORDERED `classifyThrown` chain, store-JSON summarization, fail-closed
  unknown-class rule, trust-input composition, container gate). The
  differential oracle's desk↔iOS agreement claim depends on this being a copy,
  not a re-derivation.
- **Bytes cross the bridge as staged temp files**, not base64 strings: the
  upstream reader infers container format from the file EXTENSION
  (`c2pa_read_file`), so the bridge stages bytes to
  `FileSystem.cacheDirectory` with a real extension (`.jpg/.png/.mp4/.mov/.m4a`)
  and deletes them in `finally`. This also avoids multi-hundred-MB base64
  strings for video.
- **Settings are process-global and pinned once** (`initSettings` fingerprint
  guard) — identical semantics to the desk engine; mid-process trust-material
  switching throws loudly.
- **Offline invariant:** `remote_manifest_fetch: false`, `ocsp_fetch: false`
  in settings; no TSA URL is ever passed to signing. Time anchoring stays with
  the app's existing OTS flow.
- **Sign is second-priority** (read feeding the policy layer is the
  deliverable). Both sign paths are implemented because the API surface was
  verifiable from the tagged source, but the first signed artifact MUST
  round-trip through `verify()` on a device build before captures trust it.
  The module never mints certificates — `certificateChainPEM` whose leaf
  matches the enclave key is caller-supplied (the app's existing identity
  flow owns issuance). Default enclave key tag: `com.verify.camera.signing-key`
  (the app's standard key).

## 2. Integration patch list (main agent applies)

### P1 — NEW FILE `plugins/withC2paSpm.js` (config plugin, SPM injection)

c2pa-swift has no CocoaPods pod (WS3-Binding-Path §2); SwiftPM is the only
official channel. This plugin adds the SPM package to **both** the app target
and the `C2paIos` pod target (the module's Swift code does `import C2PA`, so
the product must be linked into the pod target that compiles it).

⚠️ **UNTESTED** — no compiler on this desk; EAS is the compiler. The Xcode
project-object manipulation follows the documented community pattern
(reactnativecrossroads.com/posts/expo-plugin-add-spm-dependency,
EvanBacon/expo-apple-targets#122). Expect one iteration at first prebuild.
Manual fallback: add the package in Xcode → project → Package Dependencies,
then link `C2PA` to both targets (P6).

```js
// plugins/withC2paSpm.js — add c2pa-swift (product C2PA, exact v0.0.12) to
// the app target and the C2paIos pod target.
const { withXcodeProject } = require('expo/config-plugins');

const REPO_URL = 'https://github.com/contentauth/c2pa-swift.git';
const VERSION = '0.0.12';
const PRODUCT = 'C2PA';
// Pods project target name = podspec name in modules/c2pa-ios/ios/C2paIos.podspec
const POD_TARGET = 'C2paIos';

function ensureSpmPackage(project, targetName) {
  const target = project.pbxNativeTargetSection
    ? Object.entries(project.pbxNativeTargetSection()).find(
        ([, t]) => t && t.name === targetName || t && t.name === `"${targetName}"`,
      )
    : null;
  // NOTE: expo-modules-core pods live in the PODS project, not the app
  // project. withXcodeProject hands us the APP project; the pod target must
  // be patched in the Pods project — see the two-step approach below.
  return target;
}

const withC2paSpm = (config) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const appTargetName = cfg.modRequest.projectName;

    // 1. XCRemoteSwiftPackageReference on the app project.
    const refUuid = project.generateUuid();
    project.hash.project.objects.XCRemoteSwiftPackageReference =
      project.hash.project.objects.XCRemoteSwiftPackageReference || {};
    project.hash.project.objects.XCRemoteSwiftPackageReference[refUuid] = {
      isa: 'XCRemoteSwiftPackageReference',
      repositoryURL: REPO_URL,
      requirement: { kind: 'exactVersion', version: VERSION },
    };
    const rootId = project.getFirstProject().uuid;
    project.hash.project.objects.PBXProject[rootId].packageReferences =
      project.hash.project.objects.PBXProject[rootId].packageReferences || [];
    project.hash.project.objects.PBXProject[rootId].packageReferences.push(refUuid);

    // 2. XCSwiftPackageProductDependency + link into the app target.
    const depUuid = project.generateUuid();
    project.hash.project.objects.XCSwiftPackageProductDependency =
      project.hash.project.objects.XCSwiftPackageProductDependency || {};
    project.hash.project.objects.XCSwiftPackageProductDependency[depUuid] = {
      isa: 'XCSwiftPackageProductDependency',
      productName: PRODUCT,
      package: refUuid,
    };
    const appTarget = project.pbxNativeTargetSection();
    for (const [uuid, t] of Object.entries(appTarget)) {
      if (t && t.name === appTargetName) {
        t.packageProductDependencies = t.packageProductDependencies || [];
        t.packageProductDependencies.push(depUuid);
        const buildPhase = project
          .pbxFrameworksBuildPhaseObj(uuid);
        // add the product to the Frameworks phase
        const fileUuid = project.generateUuid();
        project.hash.project.objects.PBXBuildFile[fileUuid] = {
          isa: 'PBXBuildFile', productRef: depUuid,
        };
        project.hash.project.objects.PBXBuildFile[`${fileUuid}_comment`] =
          `${PRODUCT} in Frameworks`;
        buildPhase.files.push({ value: fileUuid, comment: `${PRODUCT} in Frameworks` });
      }
    }
    return cfg;
  });

module.exports = withC2paSpm;
```

> **Known gap in the sketch above:** `withXcodeProject` only edits the APP
> project (`ios/*.xcodeproj`), but the `C2paIos` target lives in the PODS
> project (`ios/Pods/Pods.xcodeproj`), which prebuild does not generate —
> `pod install` does. Two viable resolutions, in order of preference:
> **(a)** make the plugin idempotent against the Pods project too by adding a
> `withDangerousMod` step that opens `ios/Pods/Pods.xcodeproj` AFTER pod
> install — only works for local builds, NOT EAS (EAS runs pod install in the
> cloud without a post-pod hook);
> **(b) — RECOMMENDED for EAS:** a `Podfile` post_install hook (added via the
> `expo-build-properties`-style Podfile patch, or committed Podfile if the
> project is bare/prebuilt) that injects the SPM product reference into the
> `C2paIos` target. Since EAS prebuild regenerates `ios/` and runs pod install
> server-side, the main agent should spike path (b) first on a preview build.
> If both prove flaky, use the vendored fallback (P5).

### P2 — `app.json`: register the plugin

```json
"plugins": [
  "./plugins/withC2paSpm",
  "expo-router",
  ... (existing entries unchanged)
]
```

Module ITSELF needs no registration entry: `modules/c2pa-ios/` is autolinked
by expo-modules-core exactly like capture-kit/secure-enclave (no package.json
or app.json change for the module).

### P3 — iOS deployment target ≥ 16.0

c2pa-swift's Package.swift declares `platforms: [.iOS(.v16)]`; SPM refuses to
resolve it for a target with a lower deployment target. The podspec floor is
already 16.0. **Check** the app target's `IPHONEOS_DEPLOYMENT_TARGET` after
prebuild (Expo SDK 57 default should be ≥16 — verify once); if lower, raise it
via the plugin (`withXcodeProject` build-settings pass) or
`expo-build-properties` `ios.deploymentTarget: "16.0"` (adds a dependency —
main agent's call).

### P4 — Entitlements: NONE needed

Secure Enclave key usage requires no entitlement. `NSFaceIDUsageDescription`
(already present) covers the optional biometric-bound key. No keychain
access-group changes (c2pa-swift uses the default app keychain).

### P5 — Fallback: vendored XCFramework (if SPM injection flakes on EAS)

1. Download `https://github.com/contentauth/c2pa-swift/releases/download/v0.0.12/C2PAC.xcframework.zip`,
   verify SHA-256 = `a038bc316f7a890d1233e156cc743854cee98e24359a6176fb107088359fe0a8`
   (pin from the tagged Package.swift, verified 2026-08-06).
2. Unzip to `modules/c2pa-ios/ios/Frameworks/C2PAC.xcframework`.
3. Vendor `Library/Sources/**` of the v0.0.12 tag into
   `modules/c2pa-ios/ios/Vendor/C2PA/` WITH `LICENSE-APACHE` + `LICENSE-MIT`
   and a VENDORED.md (version, checksum, date). Podspec source_files glob
   already picks them up.
4. Podspec: add `s.vendored_frameworks = 'Frameworks/C2PAC.xcframework'`.
5. STILL SPM-inject the three pure-Swift source deps (`swift-certificates`,
   `swift-asn1`, `swift-crypto`) — `CertificateManager.swift` and
   `WebServiceSigner.swift` import them and `Signer.swift` references
   `WebServiceSigner`, so the subset cannot be trimmed without source edits.
   (Alternatively exclude those two files + the WebServiceSigner extension
   from the pod's source_files and accept losing web-service/certificate-CSR
   signing, which this app never uses.)

### P6 — EAS build

`eas build --platform ios --profile preview` compiles everything; there is no
local compiler story. First build will surface any SPM-injection issues (P1).
No `eas.json` change required.

## 3. Runtime engine selection (the seam — main agent wires it)

The bridge mirrors the desk engine's interface:

```ts
import {
  verify,                 // (bytes, mime, opts?) → NormalizedEngineResult
  readIosAsset,           // (bytes, 'photo'|'video', opts?) — desk-shaped entry
  readIosDetached,        // (manifestData, bytes, flow, opts?) — sidecar
  sign,                   // (bytes, mime, { manifestJSON, signer })
  iosEngineAvailable,     // () → boolean (false in Expo Go / pre-plugin builds)
  UPSTREAM_IOS_PINS,
  type NormalizedEngineResult, type UpstreamReadOptions,
} from './engine/upstreamEngineIos';
```

- Feed `verify(...)`'s result to `policyVerdict(...)` from the policy layer
  (synced from sourcekit-open by the main agent — the app's policyLayer is NOT
  part of this deliverable). Never compose verdicts from the normalized
  fields directly (1.0.0 audit M-06).
- Suggested seam: wherever the verify flow currently calls the hand-rolled
  verifier (`src/provenance/verifyFs.ts` entry points — DO NOT edited by this
  workstream), select `iosEngineAvailable() ? upstream-ios : handrolled` per
  the migration plan, keeping the hand-rolled engine as the differential
  oracle exactly as on desk.
- Sign path adoption (capture flow) is a SEPARATE later decision per SPEC §3 —
  verification migrates first.
- `opts.trust` pins a PEM anchor bundle + declares it `'official'|'interim'`;
  without it, `trustListHit` is honestly `'unknown'`. Trust-list PEMs ship as
  app assets (offline; refresh cadence per docs/NETWORK.md).

## 4. Swift/C2PA API certainty list

**Verified against the tagged c2pa-swift v0.0.12 source** (read directly from
`codeload.github.com/contentauth/c2pa-swift/tar.gz/refs/tags/v0.0.12`):

| API used | Source | Certainty |
|---|---|---|
| `C2PA.readFile(at:dataDir:)` | Library/Sources/C2PA.swift | verified |
| `C2PA.signFile(source:destination:manifestJSON:signerInfo:dataDir:)` | C2PA.swift | verified |
| `C2PA.version` | C2PA.swift | verified |
| `Reader(format:stream:)`, `Reader(format:stream:manifest:)`, `.json()` | Reader.swift | verified |
| `Builder(manifestJSON:)`, `builder.sign(format:source:destination:signer:)` | Builder.swift | verified |
| `Signer(info:)`, `Signer(certsPEM:privateKeyPEM:algorithm:tsa:)` | Signer.swift | verified |
| `Signer(algorithm:certificateChainPEM:tsa:secureEnclaveConfig:)` | SecureEnclaveSigner.swift | verified |
| `Signer.loadSettings(_:format:)` (process-global settings) | Signer.swift:266 | verified |
| `SecureEnclaveSignerConfig(keyTag:accessControl:)` | SecureEnclaveSigner.swift | verified |
| `SignerInfo(algorithm:certificatePEM:privateKeyPEM:tsa:)` | SignerInfo.swift | verified |
| `SigningAlgorithm(rawValue:)` es256…ed25519 | SigningAlgorithm.swift | verified |
| `Stream(readFrom:)` / `Stream(writeTo:)` (writeTo overwrites) | Stream.swift | verified |
| `C2PAError` is `LocalizedError`; `.errorDescription` preserves raw c2pa-rs text | C2PAError.swift | verified |

**Flagged (`// UNVERIFIED-API:` / integration-risk), NOT confirmed:**

1. **Extension-based format inference in `c2pa_read_file`** (comment in
   C2paIosModule.readManifest): observed c2pa-c-ffi behavior, not documented in
   c2pa-swift. Mitigation is structural — the bridge always stages files with
   true extensions, and `readManifestDetached` takes an explicit format.
2. **Settings JSON key compatibility** (`verify.verify_after_reading` /
   `verify_trust` / `ocsp_fetch` / `remote_manifest_fetch`, `trust.trust_anchors`)
   with the c2pa-rs version pinned inside v0.0.12 (§9.1 unknown). Same settings
   model as the desk binding; a key mismatch throws at `loadSettings`, loudly,
   on first verify — easy to detect in the first device run.
3. **SPM-package injection into a pod target** (P1/P5): community pattern,
   not Expo-official; the plugin sketch is untested (Binding-Path risk §8.3).
4. **DER→raw ES256 signature transcoding** for the Secure Enclave callback
   signer: delegated to upstream's own tested path (`SecureEnclaveSignerTests`
   in the tag). First on-device sign→verify round-trip confirms.
5. ~~Expo `AsyncFunction` concise throwing form~~ — **now VERIFIED**: the
   installed expo-modules-core SDK 57 declares
   `AsyncFunction(_:, closure: @escaping (A0, repeat each A) throws -> R)`
   (`node_modules/expo-modules-core/ios/Api/Factories/AsyncFunctionFactories.swift`),
   exactly the form this module uses. (Siblings use the promise style; both
   are supported.)

## 5. Validation

- `node_modules/.bin/tsc --noEmit` on the app tree with
  `upstreamEngineIos.ts` present: **the file itself is clean** (isolated
  `tsc -p` with only it in `files`: exit 0). The full-tree gate re-ran clean
  after the parallel workstreams landed; the errata files referenced here at
  authoring time have since been removed with the errata feature.
- Swift: no compiler on this desk — EAS compiles. All C2PA calls verified
  against tagged source (§4); first preview build + device round-trip
  (sign → verify) is the acceptance check.

## Applied 2026-08-08

**Path taken: React Native's first-class `spm_dependency` podspec helper — NOT
the P1 config plugin, NOT the P5 vendored fallback.** Guidance step 1 (prefer a
documented first-class mechanism) applied. `plugins/withC2paSpm.js` was never
created and `app.json` needs no plugin entry (P2 is moot).

### Why this path

- React Native ≥ 0.75 ships `spm_dependency(spec, url:, requirement:,
  products:)` as a documented library-developer API in
  `react-native/scripts/react_native_pods.rb` (verified at the pinned
 react-native@ `spm_dependency` at react_native_pods.rb:339, backed by
  `SPMManager` in `scripts/cocoapods/spm.rb`). This app pins
 `react-native@ `.
- The Expo SDK 57 Podfile template
  (`expo-template-bare-minimum@57.0.13/ios/Podfile`, the template EAS prebuild
  uses) requires `react_native_pods.rb` at the top — before any podspec is
  evaluated — and its `post_install` calls `react_native_post_install`, which
  calls `SPM.apply_on_post_install(installer)` (react_native_pods.rb:583).
  That injects the `XCRemoteSwiftPackageReference` +
  `XCSwiftPackageProductDependency` for product `C2PA` into the **Pods project**
  for the **C2paIos pod target** — exactly the P1 "known gap" target — using the
  same xcodeproj-gem objects the P1(b) sketch would have written by hand, plus
  RN's `SWIFT_INCLUDE_PATHS` workaround and built-in idempotency guards.
- Everything happens inside `pod install` (podspec evaluation → registration;
  `react_native_post_install` → Pods.xcodeproj mutation). EAS runs prebuild and
  `pod install` server-side, so this is fully reproducible from a clean
  prebuild with **zero config-plugin code and zero local hooks** — strictly
  more EAS-robust than P1(a) (app-project only, wrong project) or P1(b)
  (hand-rolled Ruby reimplementing what RN already ships and maintains).

### What changed

| Patch | Disposition |
|---|---|
| P1 (`plugins/withC2paSpm.js`) | **Replaced** by one podspec block: `spm_dependency(s, url: 'https://github.com/contentauth/c2pa-swift.git', requirement: { kind: 'exactVersion', version: '0.0.12' }, products: ['C2PA'])` in `modules/c2pa-ios/ios/C2paIos.podspec`, guarded by a `respond_to?(:spm_dependency, true)` check that raises a clear error if the mechanism is ever missing. Exact pin `v0.0.12` preserved. App-target injection from the P1 sketch deliberately dropped: nothing in the app target imports C2PA; only the C2paIos pod target compiles `import C2PA`. |
| P2 (app.json plugin entry) | **Skipped** — no plugin exists to register. app.json untouched. |
| P3 (deployment target ≥ 16.0) | **Verified, no change needed.** The SDK 57 Podfile template sets `platform :ios, podfile_properties['ios.deploymentTarget'] || '16.4'` — default 16.4 ≥ 16.0, and package.json has no expo-build-properties override that could lower it. The podspec floor stays 16.0. |
| P4 (entitlements) | Unchanged — none needed. |
| P5 (vendored XCFramework) | **Unapplied; remains the documented fallback.** |
| P6 (EAS build) | Next `eas build --platform ios --profile preview` is the acceptance check. |

`modules/c2pa-ios/ios/C2paIosModule.swift` is **unmodified** — the SPM product
name is `C2PA`, so the existing `import C2PA` resolves as-is.

### What the next EAS build should confirm

1. `pod install` succeeds and logs `[SPM] Adding SPM dependency on product
   ["C2PA"]` plus `[SPM] Adding remote package to workspace` (from
   `react-native/scripts/cocoapods/spm.rb`).
2. Pods.xcodeproj contains an `XCRemoteSwiftPackageReference` for
   `https://github.com/contentauth/c2pa-swift.git` with
   `requirement = {kind = exactVersion; version = 0.0.12; }` and the `C2paIos`
   target lists `C2PA` in `packageProductDependencies`.
3. The `C2paIos` pod target compiles (`no such module 'C2PA'` gone), including
   SPM resolution of the transitive `swift-certificates` / `swift-asn1` /
   `swift-crypto` deps and the `C2PAC.xcframework` binaryTarget download
   (SHA-256 `a038bc31…fe0a8`, pinned in the tagged Package.swift — verified
   2026-08-08 directly from the v0.0.12 tag).
4. Runtime: first device run — `getVersion`, then a sign → verify round-trip
   per §5.

### Known residual risk + fallback plan

- RN prints `[SPM] WARNING!!! Pod C2paIos is using swift package(s) C2PA with
  static linking…` because pods are statically linked by default
  (`USE_FRAMEWORKS` unset; the podspec is `s.static_framework = true`). The
  duplicate-symbol failure mode behind that warning (facebook/react-native#44627,
  expo/expo#37813) requires the **same SPM product linked into multiple
  targets**; here only the C2paIos target links `C2PA`, so the risk is low —
  but it is the most likely residual failure.
- **If the build fails with duplicate symbols / linker errors mentioning C2PA:**
  set `ios.useFrameworks: 'dynamic'` via expo-build-properties (the SDK 57
  template reads `podfile_properties['ios.useFrameworks']`), which RN's own
  warning recommends.
- **If `pod install` itself fails on `spm_dependency`:** the guard in the
  podspec raises with instructions; that would mean the Podfile no longer
  requires `react_native_pods.rb` (SDK drift) — fall back to P5 (vendored
  XCFramework, SHA-pinned) exactly as documented above.
- **If SPM resolution flakes on EAS infra:** fall back to P5 wholesale (vendor
  `Library/Sources` + `C2PAC.xcframework`, `s.vendored_frameworks`, exclude
  `CertificateManager.swift`/`WebServiceSigner.swift` per the P5 note).

## Applied 2026-08-09 — P5 vendored fallback is now THE path

**The SPM path compiled but the IPA export failed.** The EAS archive step
succeeded, then gym's `xcodebuild -exportArchive` failed with:

```
xcodebuild: error: "C2PAC.xcframework-ios.signature" couldn't be copied to
"Signatures" because an item with the same name already exists
```

— the known SPM-binary-in-static-pod export bug (RN's own `spm_dependency`
warning family; the static C2paIos pod + SPM binaryTarget signature copying
collide at export). The P5 vendored fallback is therefore no longer a
contingency — it is applied wholesale:

| Piece | State |
|---|---|
| Release zip | Downloaded, SHA-256 verified = `a038bc316f7a890d1233e156cc743854cee98e24359a6176fb107088359fe0a8` (matches the v0.0.12 Package.swift pin) |
| `modules/c2pa-ios/ios/Frameworks/` | iOS-only `C2PAC.xcframework` (device + simulator slices; macOS/maccatalyst dropped, `Info.plist` trimmed). The framework is fully STATIC (`ar` archives in `.framework` wrappers — nothing to embed/re-sign, so the export-time signature copy cannot recur). Stored as checksummed zip parts (`…part-{a,b,c}`, SHA-256 `522b65e9…399d639`) because the authoring workspace caps files at ~100 MB; the podspec `prepare_command` reassembles + verifies + unzips during `pod install`. See `Frameworks/FRAMEWORK-STORAGE.md`. |
| `modules/c2pa-ios/ios/Vendor/C2PA/` | `Library/Sources/**` of tag v0.0.12 (commit `a2812bde`, 55 files) byte-identical, + `LICENSE-APACHE`/`LICENSE-MIT` + `VENDORED.md`. **ZERO source edits were needed**: the only reference to the excluded types in the kept tree is a DocC "SeeAlso" link in a doc comment (`Signer.swift:64`). |
| Exclusions | `CertificateManager.swift`, `WebServiceSigner.swift` (the only `Crypto`/`SwiftASN1`/`X509` importers), `C2PA.docc/`. Vendored tree imports only `Foundation`/`C2PAC`/`Security`/`UIKit` — forbidden-import grep is CLEAN; **zero SPM deps remain**. |
| `C2paIos.podspec` | `spm_dependency` block + guard REMOVED; added `s.vendored_frameworks = 'Frameworks/C2PAC.xcframework'` + the reassembly `prepare_command`. iOS 16.0 floor and `s.static_framework = true` unchanged; existing `source_files` glob already covers `Vendor/C2PA/**/*.swift`. |
| `C2paIosModule.swift` | `import C2PA` REMOVED (was REQUIRED): the vendored sources compile into the `C2paIos` pod target, so `C2PA`/`Reader`/`Signer`/`Builder`/`Stream`/`SignerInfo`/`SigningAlgorithm`/`SecureEnclaveSignerConfig`/`C2PAError` are same-module; the xcframework ships only a clang module `C2PAC` (modulemap, no swiftmodules). Keeping the import would fail with "no such module 'C2PA'". No vendored file imports `C2PA` internally (grep-verified), so no other import changes exist. All module usage (Reader/Signer/manifest JSON, `loadSettings`, PEM + Secure Enclave signing) is unchanged. |

### What the next EAS build must confirm

1. `pod install` runs the `prepare_command`: parts concatenate, the SHA-256
   check passes (`shasum -a 256 -c` prints OK), and
   `Pods/../modules/c2pa-ios/ios/Frameworks/C2PAC.xcframework` exists before
   compilation.
2. The `C2paIos` pod target compiles the 55 vendored Swift files + module with
   `import C2PAC` resolving via the vendored framework's modulemap — no
   `no such module 'C2PA'`/`'C2PAC'` errors.
3. Link succeeds against the static C2PAC archive (device slice, arm64).
4. **`xcodebuild -exportArchive` / gym completes** — the signature-copy error
   is gone (nothing signed to copy; static archive is linked into the binary).
5. Runtime on device: `getVersion`, then a sign → verify round-trip per §5.

### Residual risks on this path

- `prepare_command` not re-running for an already-installed local pod: it is
  idempotent (skips when the xcframework exists), and a clean EAS prebuild
  always runs it. Manual fallback documented in `Frameworks/FRAMEWORK-STORAGE.md`.
- Simulator builds use the fat arm64+x86_64 simulator slice; EAS device
  builds use the thin arm64 slice. Both were present and intact in the
  checksum-verified zip.
- First device run still owns the §4 flagged items (settings-key compatibility,
  extension-based format inference, DER→raw ES256 transcoding).

## Applied 2026-08-09 (round 2) — prepare_command out, module visibility fixed

Two more EAS iterations closed out:

1. **`prepare_command` REMOVED from the podspec.** It ran on EAS in an
   unreliable working directory for local path pods, found no part files, and
   its `set -e` killed `pod install` outright. Assembly of
   `Frameworks/C2PAC.xcframework` from the checksummed zip parts is now a
   ONE-TIME MANUAL step on the build machine (cat parts → `shasum -a 256`
   must print the pinned digest `522b65e9…399d639` → unzip); the assembled
   xcframework then travels with every EAS upload. Instructions live in
   `Frameworks/FRAMEWORK-STORAGE.md`. The stale "prepare_command reassembles
   during pod install" row above is superseded by this note.

2. **`no such module 'C2PAC'` fixed via `pod_target_xcconfig`.** With
   `s.static_framework = true`, CocoaPods' generated `FRAMEWORK_SEARCH_PATHS`
   for the vendored xcframework points at the `XCFrameworkIntermediates`
   build dir, which was not populated when the `C2paIos` pod's own Swift
   sources (including the vendored `Vendor/C2PA/**` files that `import
   C2PAC`) compiled — the archive failed at `SwiftCompile` with "no such
   module 'C2PAC'". The podspec exposes the clang module explicitly via
   `OTHER_SWIFT_FLAGS -Xcc -fmodule-map-file=…` (SDK-conditional) pointing
   straight at the framework's OWN `module.modulemap` inside the source
   tree (a path that ships with the upload), plus `-Xcc -I…/Headers` so the
   map's `header "c2pa.h"` resolves outside framework-discovery context.
   Pointing at the same file -F discovery would find makes a
   duplicate-module conflict impossible. Linking is untouched — the static
   archive still reaches the app link step via `s.vendored_frameworks`.
   **CORRECTION (build e0348735, 2026-08-09):** the first version of this
   fix also overrode `FRAMEWORK_SEARCH_PATHS` and `SWIFT_INCLUDE_PATHS`
   with SDK-conditional assignments. In xcconfig semantics a conditional
   assignment REPLACES the unconditional one CocoaPods generates for the
   pod — it does not append — which wiped the paths carrying
   `ExpoModulesCore` (a prebuilt xcframework imported via -F): the archive
   failed with "no such module 'ExpoModulesCore'". Those two overrides
   were removed; only `OTHER_SWIFT_FLAGS` (with `$(inherited)`) is set.

What the next EAS build must confirm (revised): the `C2paIos` pod target
compiles all 55 vendored Swift files with `import C2PAC` resolving; link
succeeds against the device arm64 static archive; gym export completes
(nothing signed to copy — the all-static xcframework cannot re-trigger the
signature-copy error); then on-device `getVersion` + sign → verify per §5.

## Applied 2026-08-09 (round 3) — c2pa.h out of the pod's header set

Build 9e083e0e: the `C2paIos` pod target itself **compiled and packaged**
(`libC2paIos.a`) — `import C2PAC` and `import ExpoModulesCore` both resolve
now. The failure surfaced one stage later, in the APP target compiling
`ExpoModulesProvider.swift`: the CocoaPods-generated `C2paIos-umbrella.h`
contained **two** `#import "c2pa.h"` lines, and clang failed with
"'c2pa.h' file not found / could not build Objective-C module 'C2paIos'".

Root cause: `s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'` descends into
`Frameworks/C2PAC.xcframework/*/C2PAC.framework/Headers/c2pa.h` — once per
slice, hence two umbrella imports. Matched `.h` files become public pod
headers and land in the umbrella; the app target has no search path that
reaches inside the xcframework. Earlier builds never saw it because the
framework was absent (empty zip) or the build died a stage earlier.

Fix: `s.exclude_files = 'Frameworks/**'`. Glob behavior verified against
the tree: both c2pa.h copies excluded, all 56 Swift files retained. The
binary and its headers still ship via `s.vendored_frameworks`; Swift
visibility is unchanged (`-fmodule-map-file` in `OTHER_SWIFT_FLAGS`).

What the next EAS build must confirm (revised again): app target compiles
`import C2paIos` from a clean umbrella; final link pulls the device arm64
static archive symbols (watch for any undefined-symbol errors naming
`c2pa_*` — would mean adding a system framework/lib to the podspec, e.g.
`SystemConfiguration`); gym export completes; then on-device `getVersion`
+ sign → verify per §5.

## Applied 2026-08-09 (round 4) — the umbrella's c2pa.h comes from vendored_frameworks

Build 9878164d is the proof point: it ran with `s.exclude_files =
'Frameworks/**'` already in the podspec (verified on the build machine) and
still failed byte-identically — `C2paIos-umbrella.h:13` (and :14)
`#import "c2pa.h"` → "'c2pa.h' file not found / could not build Objective-C
module 'C2paIos'" while the APP target compiled `ExpoModulesProvider.swift`.
Conclusion: the umbrella's c2pa.h references do NOT come from the
`source_files` glob; CocoaPods exposes the vendored framework's headers as
part of the pod's public interface via `s.vendored_frameworks`, a route
neither `source_files` nor `exclude_files` governs.

Fix (two independent layers, either sufficient):

1. `s.user_target_xcconfig` adds the framework slice's `Headers/` dir to the
   APP/aggregate target's `HEADER_SEARCH_PATHS` (SDK-conditional), so the
   umbrella's quoted import resolves no matter how it got there. The
   standard `"${PODS_ROOT}/Headers/Public"` entry is replicated in the value
   because the assignment would otherwise shadow the aggregate xcconfig's
   own `HEADER_SEARCH_PATHS`.
2. `s.exclude_files = 'Frameworks/**'` retained (belt and braces; the glob
   genuinely would catch both slices' c2pa.h otherwise — verified against
   the tree: 2 caught, 0 kept, all 56 Swift files retained).

Residual risk accepted and documented: if the pod target's OWN module build
(not the app target's) ever compiles the umbrella in a context lacking the
user-target search paths, the same error could reappear in a different
phase; the fallback then is a custom `s.module_map` with no umbrella
header (the pod has zero legitimate public ObjC headers — the API is pure
Swift + ExpoModulesCore macros).

## Applied 2026-08-09 (round 5) — custom module map; the umbrella is abolished

The post-round-4 build failed with `missing required module 'C2PAC'` at
`import C2paIos` (ExpoModulesProvider.swift, app target) — the round-4
header path made c2pa.h resolvable, so clang compiled the umbrella and
discovered the header belongs to module C2PAC, not loadable in that
context. Rather than feed the umbrella a third fix, the umbrella is gone.

Decisive evidence from CocoaPods 1.16.2 source:

- `PodTargetInstaller#create_umbrella_header` is
  `super(native_target) unless custom_module_map` — with `s.module_map`
  set, **no umbrella header is generated**; `create_module_map` copies our
  file verbatim and sets `MODULEMAP_FILE`.
- The only guard, `add_swift_library_compatibility_header_phase` raising on
  custom module maps, applies solely to `build_as_library?` targets; this
  pod builds as a static framework (`s.static_framework = true`).

`modules/c2pa-ios/ios/C2paIos.modulemap` declares `framework module
C2paIos { export *; module * { export * } }` — an empty clang part, which
is correct: the pod has zero legitimate public ObjC headers (only the
CocoaPods-generated dummy.m) and its API is pure Swift, consumed via
`C2paIos.swiftmodule`. The Swift sources' `import C2PAC` still resolves
via the `pod_target_xcconfig` `-fmodule-map-file` flags (unchanged, proven
by three consecutive builds where the pod target itself compiled and
archived `libC2paIos.a`). The round-4 `user_target_xcconfig`
HEADER_SEARCH_PATHS block was REMOVED — with no umbrella there is nothing
left for the app target to resolve.

Unresolved but now moot: why `s.exclude_files = 'Frameworks/**'` (active
and verified in build 9878164d) did not keep c2pa.h out of the generated
umbrella — 1.16.2's `FileAccessor#public_headers(false)` path says it
should have. Recorded as an EAS/CocoaPods-version discrepancy; the custom
module map makes the umbrella's contents irrelevant either way.


## Applied 2026-08-10 (round 6) — the pattern was the bug: `**` → `**/*` (measured, not theorized)

Round 5 was vetoed at `pod install`: "Using Swift static libraries with
custom module maps is currently not supported." The premise was wrong —
`s.static_framework = true` only means "build as a framework IF
`use_frameworks!` is active"; this project builds pods as static
**libraries** (`libC2paIos.a`), so the round-5 guard we read as "applies
solely to `build_as_library?` targets" in fact fires for exactly our case.
`C2paIos.modulemap` is deleted and `s.module_map` reverted.

That sent the "unresolved but now moot" thread back to the front — and it
resolved completely, empirically:

- **Local reproduction.** Built Ruby 3.3.9 from source and installed
  CocoaPods 1.16.2 (EAS's version) in a Linux sandbox, created a fixture
  project using the real pod directory and the real trimmed
  C2PAC.xcframework, and ran `pod install --no-repo-update`. With
  `s.exclude_files = 'Frameworks/**'` active, the generated
  `C2paIos-umbrella.h` contained **both** `#import "c2pa.h"` lines —
  byte-identical to the dirty umbrella EAS produced in build 9878164d.
  There is no EAS/CocoaPods-version discrepancy; 1.16.2 behaves the same
  everywhere.
- **Introspection of FileAccessor.** `vendored_frameworks_headers` is
  EMPTY for this pod (round 4's "vendored route" theory was wrong — the
  umbrella generator calls `public_headers` with no arg, which excludes
  vendored-framework headers; c2pa.h enters exclusively through the
  `source_files` glob). And the exclusion list simply never matched.
- **The mechanism.** `PathList#relative_glob` applies exclude patterns via
  `File.fnmatch(pattern, path, FNM_CASEFOLD | FNM_PATHNAME)`. Under those
  flags, a **trailing `**` is not recursive** in Ruby's fnmatch (unlike
  `Dir.glob`, and unlike `'/**/'` mid-pattern, which PathList DOES expand
  via `dir_glob_equivalent_patterns`):
  - `fnmatch('Frameworks/**', 'Frameworks/C2PAC.xcframework/ios-arm64/C2PAC.framework/Headers/c2pa.h', flags)` => **false**
  - `fnmatch('Frameworks/**/*', <same path>, flags)` => **true**
  - `'Frameworks'` => false; `'Frameworks/*'` => false (only one level);
    `'Frameworks/**/c2pa.h'` => true
- **Fix verification.** Same fixture, same CocoaPods, one change —
  `s.exclude_files = 'Frameworks/**/*'` → regenerated umbrella has ZERO
  c2pa.h imports. Clean via CocoaPods' official exclusion mechanism; no
  custom module map, no app-target hacks.

Net round-6 change vs the pre-round-3 podspec: the exclude pattern gains
`*`. Everything else from rounds 2–5 (pod_target_xcconfig module visibility,
no FRAMEWORK_SEARCH_PATHS/SWIFT_INCLUDE_PATHS overrides, no
user_target_xcconfig, no custom module map) stays.

Correction ledger for this document: round 4's "comes from
vendored_frameworks" claim — falsified (introspection). Round 5's custom
module map — vetoed (install-time raise). Round 3's mechanism ("c2pa.h out
of the header set") — the goal was right; the pattern never did it.


## Applied 2026-08-10 (round 7) — @_implementationOnly: the swiftmodule leaked C2PAC to importers

Build b151a755: the round-6 fix held — the log shows `Pods/C2paIos »
libC2paIos.a` compiled and archived cleanly, umbrella era closed. New
failure, new mechanism, one target later: the APP target's
`ExpoModulesProvider.swift:12` — `internal import C2paIos` →
`missing required module 'C2PAC'` (SwiftCompile, target 'ExhibitA').

Mechanism: a compiled `.swiftmodule` records its clang-module dependencies
as load-time requirements for every importer. The vendored API layer's plain
`import C2PAC` (11 files) therefore made "must be able to resolve module
C2PAC" a property of `import C2paIos` itself. Only the pod target had the
`-Xcc -fmodule-map-file=` flags (pod_target_xcconfig); the app target never
did. Same two-word error text as the post-round-4 build, but a different
layer: round 4's instance was clang failing on a dirty umbrella header;
this instance is the Swift module graph demanding a transitive dependency.
(Should-have-anticipated, recorded honestly: the -fmodule-map-file approach
was only ever going to work for the pod target's own compilation.)

Fix — `@_implementationOnly import C2PAC` in all 11 importing files: the
canonical way to make a clang dependency private to a module so clients
need not resolve it. Pre-flight checks before applying:

- Grep: the ONLY public declaration exposing a C2PAC type was
  `public typealias Seeker = (_ offset: Int, _ origin: C2paSeekMode) -> Int`
  in Stream.swift, plus the `public convenience init(read:seek:write:flush:)`
  using it. Both demoted to internal (whole pod is one Swift module; the app
  target only touches the ExpoModulesCore DSL surface — verified
  C2paIosModule.swift uses only Stream(readFrom:)/Stream(writeTo:)/Stream(data:)).
- `C2paSignerInfo` appears only in local variables inside function bodies
  (C2PA.swift:166, Signer.swift:111) — not public API, no change needed.
- Linking unaffected: C2PAC reaches the link step via s.vendored_frameworks
  regardless of import attributes.

Alternative considered and rejected: pushing module-map flags to the app
target via user_target_xcconfig. That's the same conditional-xcconfig
shadowing mine as build e0348735 (user_target_xcconfig content merges into
the aggregate Pods-ExhibitA xcconfig where sibling assignments don't chain
through $(inherited)), and it spreads C2PAC knowledge across targets.
Removing the dependency from the module interface is strictly cleaner.

Deviation from "byte-identical to v0.0.12 tag": now two (imports + access
levels, zero functional changes) — fully enumerated in
modules/c2pa-ios/ios/Vendor/C2PA/VENDORED.md §Source edits.


## Applied 2026-08-10 (round 8) — the exclusion that fixed the umbrella unregistered the framework

Build ad5eeab8: rounds 6+7 held completely — pods compiled, `libC2paIos.a`
archived, `ExpoModulesProvider.swift` compiled clean in the app target, and
the build reached `Ld ExhibitA`. Then: `Undefined symbols for architecture
arm64` — every single one `_c2pa_*`, referenced from libC2paIos.a objects,
with the telltale warning "Could not find or use auto-linked framework
'C2PAC': framework 'C2PAC' not found". The app link line contained
`-lC2paIos` but no `-framework C2PAC` and no XCFrameworkIntermediates/C2PAC
search path (contrast: hermesvm, ExpoVideo, etc. all present). No
`[CP] Copy XCFrameworks` phase existed for C2paIos at all.

Root cause, verified against CocoaPods 1.16.2 source
(sandbox/file_accessor.rb + path_list.rb): `exclude_files` is applied by
`paths_for_attribute` to EVERY attribute — including `vendored_frameworks`,
which globs with `include_dirs=true`. Round 6's `'Frameworks/**/*'`
(PathList expands `/**/` mid-pattern, so `Frameworks/*` also matches)
matched the `C2PAC.xcframework` DIRECTORY itself, silently unregistering
the vendored framework. The round-6 local verification inspected only the
generated umbrella — never whether the framework still registered — so the
collateral damage went unnoticed until the first build that reached the
link step. Recorded as a verification-scope error.

Fix: `s.exclude_files = 'Frameworks/**/*.h'` — narrow the exclusion to
exactly the files that must stay out of the pod's source/header set (the
two slices' `Headers/c2pa.h`), which keeps the umbrella clean by the same
mechanism as round 6 while leaving the xcframework directory registered.
CocoaPods then generates the xcframeworks script phase, extracts the
ios-arm64 slice into XCFrameworkIntermediates/C2PAC, and puts
`-framework C2PAC` + its `-F` path on the app link — the static-link route
already proven in this same project by hermes-engine (static xcframework,
`-framework hermesvm`, links and archives green).

Note: the `SwiftUICore.tbd` / Metal-toolchain `ld: warning`s in the same
log are warnings that accompany ANY link failure in this toolchain; the
only fatal input was the missing C2PAC link. The expo-doctor patch bumps
applied in parallel (12 packages) were hygiene, not the fix.
