Pod::Spec.new do |s|
  s.name           = 'C2paIos'
  s.version        = '1.0.0'
  s.summary        = 'Source Kit local module: upstream C2PA read/verify/sign via c2pa-swift'
  s.description    = 'Local Expo module wrapping the official c2pa-swift SDK (v0.0.12, C2PAC.xcframework) for the Source Kit app: manifest reading/verification for JPEG/PNG/BMFF and manifest signing with PEM or Secure Enclave P-256 keys.'
  s.author         = 'noah-pi'
  s.homepage       = 'https://docs.expo.dev/modules/'
  # c2pa-swift v0.0.12 needs iOS 16.0+, and so does the app target.
  s.platforms      = { :ios => '16.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # c2pa-swift is vendored rather than pulled over SwiftPM: an SPM binary
  # target inside a static pod breaks at IPA export, where the framework's
  # signature file is copied twice.
  #
  # The Rust core links as a static xcframework fetched by
  # scripts/fetch-c2pa-framework.sh. The Swift API layer is vendored source
  # under Vendor/C2PA/** and compiles into this pod target, so its types are
  # same-module in C2paIosModule.swift and there is no `import C2PA`.
  s.vendored_frameworks = 'Frameworks/C2PAC.xcframework'

  # The vendored Swift sources `import C2PAC`, the clang module inside the
  # xcframework. CocoaPods does not reliably expose a vendored static
  # xcframework's module map to the pod target's own Swift compilation, so
  # point at the map directly and add its Headers dir so `header "c2pa.h"`
  # resolves outside framework-discovery context.
  #
  # Only OTHER_SWIFT_FLAGS is touched, and it keeps $(inherited). Do not add
  # FRAMEWORK_SEARCH_PATHS or SWIFT_INCLUDE_PATHS here: an SDK-conditional
  # assignment REPLACES the unconditional one CocoaPods generates rather than
  # appending to it, which drops the paths that make `import ExpoModulesCore`
  # resolve.
  s.pod_target_xcconfig = {
    'OTHER_SWIFT_FLAGS[sdk=iphoneos*]'        => '$(inherited) -Xcc -fmodule-map-file=$(PODS_TARGET_SRCROOT)/Frameworks/C2PAC.xcframework/ios-arm64/C2PAC.framework/Modules/module.modulemap -Xcc -I$(PODS_TARGET_SRCROOT)/Frameworks/C2PAC.xcframework/ios-arm64/C2PAC.framework/Headers',
    'OTHER_SWIFT_FLAGS[sdk=iphonesimulator*]' => '$(inherited) -Xcc -fmodule-map-file=$(PODS_TARGET_SRCROOT)/Frameworks/C2PAC.xcframework/ios-arm64_x86_64-simulator/C2PAC.framework/Modules/module.modulemap -Xcc -I$(PODS_TARGET_SRCROOT)/Frameworks/C2PAC.xcframework/ios-arm64_x86_64-simulator/C2PAC.framework/Headers',
  }

  # Network for the loopback TSA relay's NWListener; LocalAuthentication for
  # the vaulted biometric context. The SecureEnclave pod owns that vault, so
  # this pod depends on it — two pod targets, one process.
  s.frameworks = 'Security', 'Network', 'LocalAuthentication'

  s.dependency 'SecureEnclave'

  # The module's own sources plus the vendored c2pa-swift API layer.
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'

  # Exclude the xcframework's headers, and nothing else under Frameworks/.
  # CocoaPods lists matched .h files as public pod headers, so without this
  # the framework's c2pa.h lands in the generated umbrella header and breaks
  # the app target.
  #
  # This pattern is exact for three reasons, all verified against CocoaPods
  # 1.16.2. Exclusion matches with File.fnmatch under FNM_PATHNAME, so a
  # trailing '**' is not recursive and 'Frameworks/**' matches nothing.
  # exclude_files applies to every podspec attribute including
  # vendored_frameworks, so 'Frameworks/**/*' matches the xcframework
  # directory itself and unregisters it — no copy phase, no -framework on the
  # link, every c2pa_* symbol undefined. 'Frameworks/**/*.h' matches both
  # slices' headers without matching the directory.
  s.exclude_files = 'Frameworks/**/*.h'
end
