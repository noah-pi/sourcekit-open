# C2PAC.xcframework — not included in the open core

`C2PAC.xcframework` is the Rust core of [c2pa-swift](https://github.com/contentauth/c2pa-rs)
(v0.0.12, C ABI, static) that the `c2pa-ios` native module links against when
building the **iOS app**. It is a binary build dependency, not source, and it
is **deliberately not committed to this repository**:

- Nothing in the auditable core (`src/`), the validation lab (`tests/`), or the
  desk verifier (`desk/`) needs it — those run as pure TypeScript. The upstream
  C2PA engine used by the desk is the WASM package `@contentauth/c2pa-wasm`,
  pulled from npm.
- It is large (~220 MB across the iOS slices), and this repository is meant to
  be cloned and audited in minutes.
- It is redistributable but reproducible: it is derived from an official
  c2pa-swift release, so a fork building its own iOS app can obtain it from
  upstream rather than from here.

## If you are building an iOS app from a fork of this core

Fetch the framework from the c2pa-swift v0.0.12 release referenced in that
project's `Package.swift`, verify its published SHA-256, and place the
unzipped `C2PAC.xcframework/` in this directory before `pod install` / build.
The `c2pa-ios` podspec expects it here. The upstream release is the source of
truth for the exact bytes.
