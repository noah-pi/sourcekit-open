Pod::Spec.new do |s|
  s.name           = 'CaptureKit'
  s.version        = '1.0.0'
  s.summary        = 'Source Kit local module: evidentiary camera capture with streamed chunk hashing'
  s.description    = 'Local Expo module providing AVCaptureSession video/photo capture with per-1MiB-chunk SHA-256 + Merkle commitment, raw LPCM master, full-rate sensor log, and an 8-frame pre-shutter ring buffer for the Source Kit app.'
  s.author         = 'noah-pi'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'AVFoundation', 'CoreMotion', 'CoreLocation', 'CoreMedia', 'CoreVideo', 'CoreImage', 'ImageIO'

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
