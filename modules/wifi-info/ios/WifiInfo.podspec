# Source Kit 0.1.0 — pod spec for the wifi info module
Pod::Spec.new do |s|
  s.name           = 'WifiInfo'
  s.version        = '1.0.0'
  s.summary        = 'Source Kit local module: current Wi-Fi network identity (SSID/BSSID)'
  s.description    = 'Local Expo module exposing the Wi-Fi network iOS reports the device is connected to, for the Source Kit app. Requires the Wi-Fi Information entitlement and location permission; returns nil otherwise.'
  s.author         = 'noah-pi'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'NetworkExtension'

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
