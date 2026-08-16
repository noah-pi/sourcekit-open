Pod::Spec.new do |s|
  s.name           = 'AudioCapture'
  s.version        = '1.0.0'
  s.summary        = 'Exhibit A local module: audio recording with on-device live transcription'
  s.description    = 'Local Expo module providing AVAudioEngine recording to AAC .m4a with on-device Speech recognition for the Exhibit A app.'
  s.author         = 'noah-pi'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'AVFoundation', 'CoreMotion', 'Speech'

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
