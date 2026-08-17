Pod::Spec.new do |s|
  s.name           = 'C2paIos'
  s.version        = '1.0.0'
  s.summary        = 'Source Kit local module: upstream C2PA read/verify/sign via c2pa-swift'
  s.description    = 'Local Expo module wrapping the official c2pa-swift SDK (v0.0.12, C2PAC.xcframework) for the Source Kit app: manifest reading/verification for JPEG/PNG/BMFF and manifest signing with PEM or Secure Enclave P-256 keys.'
  s.author         = 'noah-pi'
  s.homepage       = 'https://docs.expo.dev/modules/'
  # c2pa-swift v0.0.12 requires iOS 16.0+ (WS3-Binding-Path §2). The APP
  # target deployment target must also be >= 16.0 — see docs/WS3-IOS-INTEGRATION.md.
  s.platforms      = { :ios => '16.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # --- c2pa-swift v0.0.12 VENDORED (docs/WS3-IOS-INTEGRATION.md §P5) ---------
  # SwiftPM via RN's `spm_dependency` COMPILED on EAS but the IPA export failed
  # ("C2PAC.xcframework-ios.signature" couldn't be copied to "Signatures"
  # because an item with the same name already exists) — the known
  # SPM-binary-in-static-pod export bug. Fallback now in effect:
  #  1. The Rust core links as a vendored STATIC xcframework (iOS slices only —
  #     the upstream zip's macOS slices are DYNAMIC and CocoaPods rejects a
  #     mixed-linkage xcframework). Setup before build: assemble it once per
  #     Frameworks/FRAMEWORK-STORAGE.md (cat parts → shasum → unzip). A
  #     prepare_command used to do this at pod install, but its working
  #     directory is unreliable for local path pods on EAS (it ran, found no
  #     part files, and killed pod install) — so it is deliberately gone. The
  #     xcframework itself travels with the project upload.
  #  2. The Swift API layer is vendored source (Vendor/C2PA/**, byte-identical
  #     to the v0.0.12 tag, minus CertificateManager.swift/WebServiceSigner.swift
  #     — see Vendor/C2PA/VENDORED.md) and compiles INTO this pod target, so
  #     the C2PA Swift types are same-module in C2paIosModule.swift (no
  #     `import C2PA` — there is no C2PA module anymore).

  s.vendored_frameworks = 'Frameworks/C2PAC.xcframework'

  #  3. The vendored Swift API layer (Vendor/C2PA/**) does `import C2PAC` — the
  #     clang module that lives inside the vendored xcframework
  #     (C2PAC.framework/Modules/module.modulemap → Headers/c2pa.h). CocoaPods
  #     does NOT reliably expose a vendored STATIC xcframework's module map to
  #     the pod target's OWN Swift compilation when s.static_framework = true
  #     (EAS archive failed with "no such module 'C2PAC'" — the generated
  #     FRAMEWORK_SEARCH_PATHS points at the XCFrameworkIntermediates build
  #     dir, which is not guaranteed populated when this pod's Swift compiles).
  #     Fix: -Xcc -fmodule-map-file straight at the map inside the source tree
  #     (the path ships with the upload, so it always exists), plus -I to the
  #     framework's Headers dir so the map's `header "c2pa.h"` resolves even
  #     when the map is loaded outside framework-discovery context.
  #
  #     TWO THINGS THIS DELIBERATELY DOES NOT DO (learned the hard way, EAS
  #     build e0348735, 2026-08-09):
  #      - It does NOT override FRAMEWORK_SEARCH_PATHS / SWIFT_INCLUDE_PATHS.
  #        In xcconfig semantics an SDK-conditional assignment REPLACES the
  #        unconditional one CocoaPods generates for this pod — it does not
  #        append. Overriding those two keys wiped the paths that make
  #        `import ExpoModulesCore` resolve (ExpoModulesCore is a prebuilt
  #        xcframework found via -F), and the archive then failed with
  #        "no such module 'ExpoModulesCore'". Only OTHER_SWIFT_FLAGS is
  #        touched, and it keeps $(inherited).
  #      - It points -fmodule-map-file at the framework's OWN module.modulemap
  #        — the exact same file framework discovery (-F) would find — so the
  #        two mechanisms can never produce a duplicate-module conflict.
  #     Linking is untouched: CocoaPods still propagates the vendored static
  #     library to the app link step via s.vendored_frameworks above.
  s.pod_target_xcconfig = {
    'OTHER_SWIFT_FLAGS[sdk=iphoneos*]'        => '$(inherited) -Xcc -fmodule-map-file=$(PODS_TARGET_SRCROOT)/Frameworks/C2PAC.xcframework/ios-arm64/C2PAC.framework/Modules/module.modulemap -Xcc -I$(PODS_TARGET_SRCROOT)/Frameworks/C2PAC.xcframework/ios-arm64/C2PAC.framework/Headers',
    'OTHER_SWIFT_FLAGS[sdk=iphonesimulator*]' => '$(inherited) -Xcc -fmodule-map-file=$(PODS_TARGET_SRCROOT)/Frameworks/C2PAC.xcframework/ios-arm64_x86_64-simulator/C2PAC.framework/Modules/module.modulemap -Xcc -I$(PODS_TARGET_SRCROOT)/Frameworks/C2PAC.xcframework/ios-arm64_x86_64-simulator/C2PAC.framework/Headers',
  }

  s.frameworks = 'Security'

  # Globs pick up the module's own sources AND the vendored c2pa-swift API
  # layer under Vendor/C2PA/**/*.swift.
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'

  # ...but NOT anything inside the vendored xcframework: the glob above
  # otherwise catches Frameworks/C2PAC.xcframework/*/C2PAC.framework/
  # Headers/c2pa.h (once per slice) and CocoaPods lists matched .h files as
  # PUBLIC pod headers — which land in the generated C2paIos-umbrella.h and
  # break the APP target ("'c2pa.h' file not found / could not build
  # Objective-C module 'C2paIos'", then "missing required module 'C2PAC'").
  #
  # THE PATTERN MUST BE SURGICAL — exclude ONLY the framework's headers, never
  # the framework itself. Hard-won mechanics (all verified against CocoaPods
  # 1.16.2 source + real pod installs, 2026-08-10):
  #  1. PathList exclusion matches with File.fnmatch (FNM_PATHNAME): a TRAILING
  #     '**' is NOT recursive — 'Frameworks/**' matched NOTHING (that was EAS
  #     build 9878164d's failure: umbrella intact despite exclude_files).
  #  2. ...but exclude_files applies to EVERY podspec attribute via
  #     FileAccessor#paths_for_attribute — including vendored_frameworks, which
  #     globs WITH include_dirs=true. 'Frameworks/**/*' therefore matched the
  #     C2PAC.xcframework DIRECTORY itself, unregistering it entirely: no
  #     [CP] Copy XCFrameworks phase, no -framework C2PAC on the app link, and
  #     the archive died at Ld with every c2pa_* symbol undefined (EAS build
  #     ad5eeab8, Xcode log line 49245+: "Could not find or use auto-linked
  #     framework 'C2PAC'").
  #  3. 'Frameworks/**/*.h' matches both slices' Headers/c2pa.h (umbrella stays
  #     clean — the round-6 goal, verified by local pod install) but does NOT
  #     match the xcframework directory, so vendored_frameworks registers, the
  #     ios-arm64 slice extracts to XCFrameworkIntermediates/C2PAC, and
  #     -framework C2PAC reaches the app link — the same static-link route
  #     hermes-engine already uses successfully in this project.
  # (Round 5's custom s.module_map was vetoed at pod install — "Using Swift
  #  static libraries with custom module maps is currently not supported" —
  #  because this project builds pods as static LIBRARIES (libC2paIos.a).)
  s.exclude_files = 'Frameworks/**/*.h'
end
