# UNBUILT — rides EAS build 2; validated by on-device soak checklist, not CI.
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
  # Public so the pod's Swift sources see the NSException-safe session
  # lifecycle shim (ExhibitSessionControl) through the generated umbrella
  # header — framework targets have no bridging header; a public header is
  # the same-module Swift→ObjC path (0.15.0 Drop 2).
  s.public_header_files = 'ExhibitSessionControl.h'
end
