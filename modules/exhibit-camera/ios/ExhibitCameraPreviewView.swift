// UNBUILT — rides EAS build 2; validated by on-device soak checklist, not CI.
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

  /// 0.18.9 crash hardening: nil the PiP layer's session on the module's
  /// behalf. Called on the module's sessionQueue — AVCaptureVideoPreviewLayer
  /// serializes session attachment internally (its Fig sync queue), so the
  /// setter is safe from any queue EXCEPT that queue itself; sessionQueue
  /// gives us total ordering with the session's begin/commit/stop, which is
  /// exactly what the 0.18.8 field crashes lacked (main-thread setSession:
  /// blocked inside a synchronous graph commit → 0x8BADF00D; async-hop
  /// detach let a bound layer+session die on a Fig workloop → SIGABRT).
  func detachPipFromSession() {
    pipLayer?.session = nil
  }

  deinit {
    // Fabric can deallocate views OFF the main thread. Unbinding the preview
    // layer inline triggered the fielded SIGABRT class: layer dealloc →
    // session dealloc → detachFromFigCaptureSession assert on a Fig workloop.
    // Hop the unbind to a GLOBAL queue (never the Fig sync queue, so no
    // reentrant detach assert) and RETAIN both layers through the hop, so
    // they release deterministically there — after the module's ordered
    // teardown has already unbound them in the normal case.
    let pl = previewLayer
    let pip = pipLayer
    DispatchQueue.global(qos: .userInitiated).async {
      pl.session = nil
      pip?.session = nil
    }
  }

  // MARK: - Module wiring (called from the module's View Prop handlers)

  func attach(module: ExhibitCameraModule) {
    moduleRef = module
    // Pull the current session if one is already running (view mounted
    // after configureSession — e.g. re-attach on navigation). The bind
    // itself runs on the module's sessionQueue (0.18.9: never on main).
    module.attachViewOnSessionQueue(self)
  }

  /// Called by the module ON ITS sessionQueue when a session starts or
  /// stops. nil unbinds — a black preview is honest; a frozen last frame is
  /// not, so on unbind we clear the layer's connection by dropping the
  /// session. Off-main by design: on main this setter can synchronously
  /// commit the capture graph and stall long enough for the scene-update
  /// watchdog to kill the app (0.18.8 field log 6545F417); from sessionQueue
  /// the same call is ordered against begin/commit/stop by the serial queue.
  func bind(session: AVCaptureSession?) {
    if previewLayer.session !== session {
      previewLayer.session = session
      reportedReadyForSession = nil
    }
    applyRotation()
  }

  /// Called by the module (sessionQueue) when the first synchronized frame
  /// lands. `signal` states which readiness signal fired (spec §2).
  /// EventDispatcher hops to JS itself.
  func reportReady(session: AVCaptureSession, signal: String) {
    let id = ObjectIdentifier(session)
    guard reportedReadyForSession != id else { return }
    reportedReadyForSession = id
    onPreviewReady(["signal": signal])
  }

  // MARK: - Alt-view PiP (0.14.0 — transparency: the second camera's feed
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
  /// Queue note (0.18.9): runs on the module's sessionQueue (from bind) and
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
