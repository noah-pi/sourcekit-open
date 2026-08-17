# Vendored c2pa-swift — provenance and modifications

**Vendored on:** 2026-08-09
**Upstream:** https://github.com/contentauth/c2pa-swift, tag `v0.0.12`
(commit `a2812bdebcff324aa68fecba804e10e2144d5e4f`, `git describe` = v0.0.12)

## Why vendored

The SwiftPM path (RN `spm_dependency` podspec helper) COMPILED on EAS but the
IPA export (gym / `xcodebuild -exportArchive`) failed with:

```
xcodebuild: error: "C2PAC.xcframework-ios.signature" couldn't be copied to
"Signatures" because an item with the same name already exists
```

— the known SPM-binary-inside-static-pod export bug. This vendored copy is the
documented P5 fallback in `docs/WS3-IOS-INTEGRATION.md`.

## What is here

`Library/Sources/**` of the v0.0.12 tag, copied verbatim, minus the exclusions
below — 55 Swift files. Licenses `LICENSE-APACHE` / `LICENSE-MIT` are copied
alongside from the tag (Apache-2.0 OR MIT dual license).

The Rust core is NOT here: it ships as the static `C2PAC.xcframework` in
`../../Frameworks/` (see `../../Frameworks/FRAMEWORK-STORAGE.md` for its
checksums and chunked-storage reassembly — the workspace that produced this
commit caps files at ~100 MB, so the iOS-only zip is stored split and
reassembled by the podspec `prepare_command`).

## Checksums (verified at vendor time)

- Original release zip `C2PAC.xcframework.zip` (all 4 slices, 370 MB):
  SHA-256 `a038bc316f7a890d1233e156cc743854cee98e24359a6176fb107088359fe0a8`
  — matches the pin in the tagged Package.swift. Verified twice (2026-08-09).
- Trimmed iOS-only zip actually stored in this repo
  (`Frameworks/C2PAC-ios.xcframework.zip.part-{a,b,c}`, cat in order):
  SHA-256 `522b65e928eacc43c9d189cb9c54e4512ef7b063f9a95469e9eca65ab399d639`.
  Derived from the verified original; only the unused `macos-arm64_x86_64` and
  `ios-arm64_x86_64-maccatalyst` slices were dropped and `Info.plist`'s
  `AvailableLibraries` was trimmed accordingly. The podspec `prepare_command`
  re-verifies this checksum before unzipping.

## Exclusions (vs upstream `Library/Sources/`)

- `CertificateManager.swift` — imports `Crypto`, `SwiftASN1`, `X509`
  (swift-certificates / swift-asn1 / swift-crypto SPM packages). CSR/certificate
  helpers; this app never mints certificates (identity flow is caller-supplied).
- `WebServiceSigner.swift` — same three SPM imports plus `os`; contains the
  `extension Signer` web-service signing initializers. Remote-signing only;
  the app's offline invariant (no network in the signing path) never uses it.
- `C2PA.docc/` — documentation catalog only, not compiled.

After these exclusions the vendored tree imports ONLY `Foundation`, `C2PAC`,
`Security`, `UIKit` — zero SPM dependencies. Verified:
`grep -rn 'import SwiftCertificates\|import SwiftASN1\|import Crypto\|import X509'`
over the vendored tree → no matches.

## Source edits

**TWO, both applied 2026-08-10 (round 7), both confined to imports/access
levels — zero functional-code changes.** Until this date the section read
"NONE; every vendored `.swift` file is byte-identical to the v0.0.12 tag"
(see git history), which was true at vendor time.

1. **`import C2PAC` → `@_implementationOnly import C2PAC`** in the 11 files
   that import the clang module (Builder, C2PA, C2PASettings, Helpers,
   Intent, KeychainSigner, Reader, SecureEnclaveSigner, Signer,
   SigningAlgorithm, Stream). Reason: a compiled `.swiftmodule` records its
   clang-module dependencies as *requirements for every importer*. The app
   target's `ExpoModulesProvider.swift` does `import C2paIos` and therefore
   transitively needed module C2PAC resolvable — which only the pod target's
   own `-Xcc -fmodule-map-file=` flags provided. EAS build b151a755 failed
   with `missing required module 'C2PAC'` at that line (the pod itself had
   already compiled + archived `libC2paIos.a` cleanly in the same build).
   `@_implementationOnly` makes the C dependency private to this module, the
   canonical fix; linking is unaffected (C2PAC is statically linked via
   `s.vendored_frameworks` regardless).
2. **Access demotions in `Stream.swift`** required by (1), since
   implementation-only types may not appear in public API:
   - `public typealias Seeker` → `typealias Seeker` (its signature uses the
     C enum `C2paSeekMode`)
   - `public convenience init(read:seek:write:flush:)` → `convenience init`
     (its `seek:` parameter uses `Seeker`)
   Verified before demoting: nothing outside `Stream.swift` references
   `Seeker` or that initializer — `C2paIosModule.swift` uses only
   `Stream(readFrom:)`, `Stream(writeTo:)`, and `Stream(data:)`, all still
   public. The whole pod is one Swift module, so internal is sufficient.
   All other public API is untouched; `Reader`/`Writer`/`Flusher` typealiases
   stay public (standard pointer types only).

A DocC "SeeAlso" symbol link to an excluded type remains in a doc comment
(`Signer.swift:64`, `/// - SeeAlso: ... ``WebServiceSigner```) — harmless
(worst case: a documentation-build warning).

## Module-name note (why `import C2PA` was removed from C2paIosModule.swift)

Under SPM these files compiled into the library product `C2PA`, so consumers
wrote `import C2PA`. Vendored, they compile INTO the `C2paIos` pod target, so
the types (`C2PA`, `Reader`, `Signer`, `Builder`, `Stream`, `SignerInfo`,
`SigningAlgorithm`, `SecureEnclaveSignerConfig`, `C2PAError`, …) are
same-module and directly visible — `import C2PA` would fail with
"no such module 'C2PA'". The vendored sources' only binary dependency is the
clang module `C2PAC` (the XCFramework ships `Headers/c2pa.h` +
`Modules/module.modulemap`, no swiftmodules), which `s.vendored_frameworks`
puts on the framework search path. No vendored file imports `C2PA` or uses
`@_exported import` (verified by grep), so no other import changes exist.
