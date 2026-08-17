Pod::Spec.new do |s|
  s.name           = 'SecureEnclave'
  s.version        = '1.0.0'
  s.summary        = 'Source Kit local module: Secure Enclave signing + Apple App Attest'
  s.description    = 'Local Expo module providing Secure Enclave key management, ECDSA signing and App Attest for the Source Kit app.'
  s.author         = 'noah-pi'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'Security', 'DeviceCheck'

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
