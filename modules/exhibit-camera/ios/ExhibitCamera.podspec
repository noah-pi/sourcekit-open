Pod::Spec.new do |s|
  s.name           = 'ExhibitCamera'
  s.version        = '1.0.0'
  s.summary        = 'Source Kit local module: fused single-session camera with multi-cam stereo capture'
  s.description    = 'Local Expo module owning the app\'s only AVCaptureMultiCamSession: native preview, camera chrome, synchronized stereo pair capture with committed calibration + metadata, periodic stereo pairs during video, and true Bayer RAW opt-in. Commits inputs, never computed answers.'
  s.author         = 'noah-pi'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'AVFoundation', 'CoreMotion', 'CoreMedia', 'CoreVideo', 'CoreImage', 'ImageIO'

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
  # Public so the pod's Swift sources reach the NSException-safe session
  # shim through the generated umbrella header. Framework targets have no
  # bridging header, so a public header is the Swift-to-ObjC path.
  s.public_header_files = 'ExhibitSessionControl.h'
end
