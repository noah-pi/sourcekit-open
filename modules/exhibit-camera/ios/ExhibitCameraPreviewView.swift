// UNBUILT — rides EAS build 2; validated by on-device soak checklist, not CI.
import ExpoModulesCore
import AVFoundation
import UIKit

/**
 * Native preview for the single capture session (spec §2). The backing
 * layer is an AVCaptureVideoPreviewLayer bound to the module's
 * AVCaptureMultiCamSession, so preview and recording share one session.
 * The view only binds and unbinds a layer; the module owns session
 * lifetime, driven from JS on screen focus/blur.
 */
public final class ExhibitCameraPreviewView: ExpoView {

  /// View-scoped event (spec §2): fires once per session bind when the
  /// module reports first frames. Payload names the readiness signal.
  let onPreviewReady = EventDispatcher()

  /// Backing layer is the preview layer (layerClass override below), so
  /// Auto Layout / Fabric resizing needs no manual frame math.
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

  /// Nils the PiP layer's session on the module's behalf. Must be called on
  /// the module's sessionQueue, which orders it against the session's
  /// begin/commit/stop; main-thread or async-hop detach crashes.
  func detachPipFromSession() {
    pipLayer?.session = nil
  }

  deinit {
    // Fabric can deallocate views off the main thread, and an inline unbind
    // asserts in detachFromFigCaptureSession on a Fig workloop. Hop the
    // unbind to a global queue and retain both layers through the hop so
    // they release there.
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
    // Picks up a session that is already running (view mounted after
    // configureSession, e.g. re-attach on navigation). The bind runs on
    // the module's sessionQueue, never on main.
    module.attachViewOnSessionQueue(self)
  }

  /// Called by the module on its sessionQueue when a session starts or
  /// stops. Passing nil unbinds, clearing the layer to black rather than
  /// leaving a frozen frame. Must stay off main: there the setter can
  /// commit the capture graph synchronously and trip the scene-update
  /// watchdog.
  func bind(session: AVCaptureSession?) {
    if previewLayer.session !== session {
      previewLayer.session = session
      reportedReadyForSession = nil
    }
    applyRotation()
  }

  /// Called by the module (sessionQueue) when the first synchronized frame
  /// lands. `signal` names the readiness signal (spec §2). EventDispatcher
  /// hops to JS itself.
  func reportReady(session: AVCaptureSession, signal: String) {
    let id = ObjectIdentifier(session)
    guard reportedReadyForSession != id else { return }
    reportedReadyForSession = id
    onPreviewReady(["signal": signal])
  }

  // MARK: - Alt-view PiP

  /// Sublayer of the preview layer, display-only. The module owns the
  /// AVCaptureConnection feeding it from the secondary input's video port;
  /// with no connection the inset stays empty.
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

  /// Top-right inset, clear of the JS HUD. The center-top stack (recWrap
  /// at top:96, zoom row at top:140 with ~36 pt pills) reaches ~176, so the
  /// inset starts at 196. 26% of view width, 3:4 portrait.
  private func layoutPipLayer() {
    guard let layer = pipLayer else { return }
    let w = bounds.width * 0.26
    let h = w * 4.0 / 3.0
    layer.frame = CGRect(x: bounds.maxX - w - 14, y: 196, width: w, height: h)
  }

  // MARK: - Orientation

  /// iOS 17+: takes the horizon-level preview angle from a per-device
  /// AVCaptureDevice.RotationCoordinator rather than a fixed constant,
  /// which renders sideways on portrait-mounted sensors such as iPhone 17's
  /// front camera. Device comes from the bound session's video input; with
  /// no session there is no connection to rotate. Pre-17 falls back to
  /// videoOrientation. Runs on both sessionQueue and main, and touches only
  /// internally synchronized AVFoundation state.
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
