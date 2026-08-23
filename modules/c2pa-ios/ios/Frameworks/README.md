# C2PAC.xcframework

The Rust core of c2pa-swift v0.0.12, exposed over a C ABI. The `c2pa-ios`
module's vendored Swift sources import it as the clang module `C2PAC`.

It is not committed here. Fetch it before building:

```sh
./scripts/fetch-c2pa-framework.sh
```

That downloads the release zip from
[contentauth/c2pa-swift](https://github.com/contentauth/c2pa-swift/releases/tag/v0.0.12),
checks it against the SHA-256 pinned in upstream's own `Package.swift`
(`a038bc31…9fe0a8`), unpacks it here, and drops the `macos-arm64_x86_64` and
`ios-arm64_x86_64-maccatalyst` slices — CocoaPods rejects an xcframework whose
slices mix static and dynamic linkage, and nothing here builds for either
platform.

Every slice is a static archive, so there is nothing to embed or re-sign at
IPA export.

The result must be on disk before `eas build`; the upload includes it.
