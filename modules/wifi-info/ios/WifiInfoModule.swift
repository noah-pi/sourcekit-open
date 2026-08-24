// Written with AI assistance. Verification: docs/PROVENANCE.md.
import ExpoModulesCore
import NetworkExtension

/**
 * Current Wi-Fi identity as iOS reports it. SSIDs and BSSIDs are spoofable,
 * so this is signed as a claim, not as location. Returns nil unless the
 * wifi-info entitlement, location when-in-use (SSID counts as location since
 * iOS 14), and a live association all hold. Opt-in, default off, stripped on
 * de-identify. API: currentWifi -> [String: String]? — { ssid, bssid } or nil.
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
