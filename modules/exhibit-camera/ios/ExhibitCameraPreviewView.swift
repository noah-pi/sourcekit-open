// Source Kit 0.1.0 — native preview for the app's ONE capture session
import ExpoModulesCore
import AVFoundation
import UIKit

/**
 * ExhibitCameraPreviewView — native preview for the app's ONE capture
 * session (spec §2). The backing layer IS an AVCaptureVideoPreviewLayer
 * bound to the module's AVCaptureMultiCamSession. Preview is the same
 * session that records — zero hardware contention by construction.
 *
 * This view NEVER owns, starts, or stops the session. It binds and unbinds
 * a layer. Session lifetime is the module's; screen focus/blur drives it
 * from JS.
 *
 * REVIEW-CHECK (EAS): `ExpoView` + `override class var layerClass` is the
 * standard UIKit pattern for a layer-backed view; confirm ExpoView (which
 * extends RCTView) does not fight the custom layer class under Fabric.
 * Fallback if it does: a plain subview-managed CALayer hierarchy (add the
 * preview layer as a sublayer in layoutSubviews).
 */
public final class ExhibitCameraPreviewView: ExpoView {

  /// View-scoped event (spec §2): fired once per session bind when the
  /// module reports first frames. Payload states WHICH readiness signal
  /// fired — never an ambiguous "ready".
  let onPreviewReady = EventDispatcher()

  /// The view's backing layer is the preview layer (layerClass override
  /// below), so Auto Layout / Fabric resizing flows through with no
  /// manual frame math.
  private var previewLayer: AVCaptureVideoPreviewLayer {
    // layerClass guarantees this cast.
    guard let pl = layer as? AVCaptureVideoPreviewLayer else {
      fatalError("ExhibitCameraPreviewView backing layer is not AVCaptureVideoPreviewLayer")
    }
    return pl
  }

  public override class var layerClass: AnyClass {
    return AVCaptureVideoPreviewLayer.self
  }

  /// Set by the module at prop-update time. Weak: the module owns the
  /// session, the view is display-only.
  private weak var moduleRef: ExhibitCameraModule?

  /// Readiness is reported once per bound session, not per layout pass.
  private var reportedReadyForSession: ObjectIdentifier?

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    previewLayer.videoGravity = .resizeAspectFill
  }

  /// crash hardening: nil the PiP layer's session on the module's
  /// behalf. Called on the module's sessionQueue — AVCaptureVideoPreviewLayer
  /// serializes session attachment internally (its Fig sync queue), so the
  /// setter is safe from any queue EXCEPT that queue itself; sessionQueue
  /// gives us total ordering with the session's begin/commit/stop, which is
  /// exactly what the a crash lacked (main-thread setSession:
  /// blocked inside a synchronous graph commit → 0x8BADF00D; async-hop
  /// detach let a bound layer+session die on a Fig workloop → SIGABRT).
  func detachPipFromSession() {
    pipLayer?.session = nil
  }

  deinit {
    // Fabric can deallocate views OFF the main thread. Unbinding the preview
    // layer inline triggered the fielded SIGABRT class: layer dealloc →
    // session dealloc → detachFromFigCaptureSession assert on a Fig workloop.
    // hop the unbind
    // to the MODULE's sessionQueue — not an unconstrained global queue.
    // sessionQueue is serial, so this unbind is ordered AHEAD of any session
    // tomb timer enqueued before it (the tomb fires 5 s after teardown; a
    // global hop has no ordering guarantee at all and lost that race in the
    // field: the tomb's capture release became the session's last with this
    // layer still attached → the SIGABRTs). The module's bound-layer
    // registry sweep is the independent backstop: this layer was registered
    // at bind time, so the tomb detaches it before the final release even
    // if this hop somehow lands late. Global fallback only when the module
    // (and its queue) is already gone — no live session can be attached
    // then, so the unbind is bookkeeping.
    let pl = previewLayer
    let pip = pipLayer
    if let module = moduleRef {
      module.enqueueLayerUnbind(preview: pl, pip: pip)
    } else {
      DispatchQueue.global(qos: .userInitiated).async {
        pl.session = nil
        pip?.session = nil
      }
    }
  }

  // MARK: - Module wiring (called from the module's View Prop handlers)

  func attach(module: ExhibitCameraModule) {
    moduleRef = module
    // Pull the current session if one is already running (view mounted
    // after configureSession — e.g. re-attach on navigation). The bind
    // itself runs on the module's sessionQueue (: never on main).
    module.attachViewOnSessionQueue(self)
  }

  /// Called by the module ON ITS sessionQueue when a session starts or
  /// stops. nil unbinds — a black preview is honest; a frozen last frame is
  /// not, so on unbind we clear the layer's connection by dropping the
  /// session. Off-main by design: on main this setter can synchronously
  /// commit the capture graph and stall long enough for the scene-update
  /// watchdog to kill the app; from sessionQueue
  /// the same call is ordered against begin/commit/stop by the serial queue.
  func bind(session: AVCaptureSession?) {
    if previewLayer.session !== session {
      previewLayer.session = session
      reportedReadyForSession = nil
      // (field, /59: "turn on the selfie cam and sometimes
      // still see the rear cam"): a detached AVCaptureVideoPreviewLayer
      // keeps painting its LAST frame indefinitely — after a facing flip
      // that stale frame is the REAR camera on screen while the UI says
      // selfie. Hide the layer exactly while it has no live session;
      // reportReady (the first real frame of the new session) lifts the
      // shield. A black beat is honest; another camera's frozen frame is
      // not.
      if session == nil { previewLayer.opacity = 0 }
    }
    applyRotation()
  }

  /// diagnostics: which port the whole-session bind's IMPLICIT
  /// connection landed on. A virtual dual-wide input offers three video
  /// ports — the zoom-following default port and the two fixed-constituent
  /// secret ports — and which one the OS picked decides whether the live
  /// preview can follow zoom at all. Read on the module's sessionQueue.
  func previewSourceDeviceType() -> String {
    guard let port = previewLayer.connection?.inputPorts.first else { return "unbound" }
    return port.sourceDeviceType?.rawValue ?? "unknown"
  }

  /// Called by the module (sessionQueue) when the first synchronized frame
  /// lands. `signal` states which readiness signal fired (spec §2).
  /// EventDispatcher hops to JS itself.
  func reportReady(session: AVCaptureSession, signal: String) {
    let id = ObjectIdentifier(session)
    guard reportedReadyForSession != id else { return }
    reportedReadyForSession = id
    // First real frame of THIS session: the stale-frame shield (bind)
    // lifts only here — the preview goes black → live, never black →
    // stale. Guarded on the CURRENT bind so a late signal from a dead
    // session can't un-hide a layer that's bound to nothing.
    if previewLayer.session === session { previewLayer.opacity = 1 }
    onPreviewReady(["signal": signal])
  }

  // MARK: - Alt-view PiP ( transparency: the second camera's feed
  // is on screen exactly while it is attached)

  /// The PiP layer is a SUBLAYER of the preview layer — display-only; the
  /// module owns the AVCaptureConnection that feeds it from the secondary
  /// input's video port. No connection, no image: an empty inset is never
  /// a fabricated feed.
  private var pipLayer: AVCaptureVideoPreviewLayer?

  /// Main thread (prop handler): create/remove the inset layer.
  func setAltPreviewEnabled(_ enabled: Bool) {
    if enabled {
      guard pipLayer == nil else { return }
      let layer = AVCaptureVideoPreviewLayer()
      layer.videoGravity = .resizeAspectFill
      layer.masksToBounds = true
      layer.cornerRadius = 12
      layer.borderWidth = 1.0 / UIScreen.main.nativeScale
      layer.borderColor = UIColor.white.withAlphaComponent(0.55).cgColor
      layer.backgroundColor = UIColor.black.cgColor
      previewLayer.addSublayer(layer)
      pipLayer = layer
      setNeedsLayout()
    } else if let layer = pipLayer {
      pipLayer = nil
      layer.removeFromSuperlayer()
    }
  }

  /// The layer the module should bind — nil when the inset is off.
  func currentPipLayer() -> AVCaptureVideoPreviewLayer? {
    return pipLayer
  }

  /// the backing preview layer, for the module's bound-layer
  /// registry (registered at bind time, swept at teardown and before the
  /// session tomb's final release — see the module's boundPreviewLayers).
  func currentPreviewLayer() -> AVCaptureVideoPreviewLayer {
    return previewLayer
  }

  /// Top-right inset, clear of the JS HUD. The center-top stack owns more
  /// than the old ~110 pt: recWrap at top:96 and the zoom row at top:140
  /// (pills ~36 pt) reach to ~176, and the zoom row's pills can extend under
  /// this corner on narrow devices — so the PiP starts below the stack, at
  /// 196. 26% of the view width, 3:4 portrait — a glance, never a second
  /// viewfinder.
  private func layoutPipLayer() {
    guard let layer = pipLayer else { return }
    let w = bounds.width * 0.26
    let h = w * 4.0 / 3.0
    layer.frame = CGRect(x: bounds.maxX - w - 14, y: 196, width: w, height: h)
  }

  // MARK: - Orientation

  /// iOS 17+: the horizon-level PREVIEW angle from an
  /// AVCaptureDevice.RotationCoordinator, per device — NEVER a hardcoded
  /// constant. iPhone 17's Center Stage front camera has a portrait-mounted
  /// sensor (WWDC 2026 session 341); the legacy 90° constant rendered the
  /// front preview sideways there. The device is discovered from the bound
  /// session's video input; pre-bind (no session) there is no connection
  /// and nothing to rotate. Legacy: videoOrientation.
  /// Queue note: runs on the module's sessionQueue (from bind) and
  /// on main (from layoutSubviews). It mutates only AVFoundation state —
  /// connection angle, coordinator — never the view hierarchy; both are
  /// internally synchronized.
  func applyRotation() {
    guard let connection = previewLayer.connection else { return }
    if #available(iOS 17.0, *) {
      guard let device = previewLayer.session?.inputs
        .compactMap({ ($0 as? AVCaptureDeviceInput)?.device })
        .first(where: { $0.hasMediaType(.video) }) else { return }
      RotationPolicy.apply(to: connection, device: device, previewLayer: previewLayer)
    } else {
      if connection.isVideoOrientationSupported {
        connection.videoOrientation = .portrait
      }
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    applyRotation()
    layoutPipLayer()
  }
}
