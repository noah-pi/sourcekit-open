import ExpoModulesCore
import NetworkExtension

/**
 * Current Wi-Fi network identity: the SSID/BSSID iOS reports. SELF-REPORTED by
 * the OS — SSIDs and MACs are trivially spoofable — so it is signed as a claim
 * for a desk to weigh, never proof of place. Returns nil unless all iOS gates
 * hold: wifi-info entitlement, location when-in-use (SSID is location data
 * since iOS 14), and an actual Wi-Fi association. Opt-in only (default off),
 * stripped on de-identify; BSSID→location lookup happens desk-side only.
 * API: currentWifi() -> [String: String]? — { ssid, bssid } or nil.
 */
public class WifiInfoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WifiInfo")

    AsyncFunction("currentWifi") { (promise: Promise) in
      // NEHotspotNetwork.fetchCurrent (iOS 14+; floor 15.1): nil completion
      // unless entitlement + location permission are in place.
      NEHotspotNetwork.fetchCurrent { network in
        guard let network = network else {
          promise.resolve(nil)
          return
        }
        promise.resolve(["ssid": network.ssid, "bssid": network.bssid])
      }
    }
  }
}
