# C2PAC.xcframework — chunked storage

`C2PAC.xcframework` is c2pa-swift v0.0.12's Rust core (C ABI), a fully STATIC
xcframework (each `C2PAC.framework/C2PAC` is an `ar` archive — no dynamic
framework, nothing to embed or re-sign at IPA export, which is exactly why the
SPM-export signature-copy failure cannot recur on this path).

The iOS slices are too large for the ~100 MB per-file cap of the workspace that
produced this commit, so they are stored as a checksummed zip split into parts:

- `C2PAC-ios.xcframework.zip.part-{a,b,c}` — `cat` in alphabetical order.
- Reassembled zip SHA-256:
  `522b65e928eacc43c9d189cb9c54e4512ef7b063f9a95469e9eca65ab399d639`
- Derived from the upstream release zip
  (SHA-256 `a038bc316f7a890d1233e156cc743854cee98e24359a6176fb107088359fe0a8`,
  verified against the pin in the v0.0.12 Package.swift) by dropping the
  `macos-arm64_x86_64` and `ios-arm64_x86_64-maccatalyst` slices and trimming
  `Info.plist` `AvailableLibraries` to `ios-arm64` +
  `ios-arm64_x86_64-simulator` (an iOS-only pod never uses the dropped slices).

**Manual assembly is REQUIRED before each build from a fresh checkout** (the
former podspec `prepare_command` was removed 2026-08-09: its working directory
is unreliable for local path pods on EAS — it ran, found no parts, and killed
pod install). Assemble, then leave the result in place — it travels with the
project upload:

```sh
cd modules/c2pa-ios/ios
cat Frameworks/C2PAC-ios.xcframework.zip.part-* > /tmp/C2PAC-ios.zip
echo "522b65e928eacc43c9d189cb9c54e4512ef7b063f9a95469e9eca65ab399d639  /tmp/C2PAC-ios.zip" | shasum -a 256 -c -
unzip -oq /tmp/C2PAC-ios.zip -d Frameworks
```

`Frameworks/C2PAC.xcframework/` (the unzipped result) is a local build artifact
— do not commit it to git; only the parts are committed. It MUST be present on
disk before `eas build` (the EAS upload includes it).
