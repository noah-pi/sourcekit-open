// Written with AI assistance. Verification: docs/PROVENANCE.md.
import Foundation
import Network

/**
 * One-shot loopback relay for the RFC 3161 timestamp round-trip.
 *
 * The vendored c2pa-swift stack attempts the sigTst fetch itself, but drives
 * it through a fresh Context whose default blocking resolver does not
 * complete from an app process, and the builder path exposes no resolver
 * seam. So the SDK is pointed at a listener on 127.0.0.1 (OS-assigned port,
 * alive for a single sign call). The relay accepts the core's one POST,
 * forwards it to the configured authority over URLSession, and on an
 * upstream 200 sets the `application/timestamp-reply` content type the core
 * requires — `time_stamp_request_http` demands status 200 and that exact
 * type. Any other outcome is answered with an honest status and recorded in
 * `lastError`, which the module appends to the thrown error.
 *
 * Limits: HTTP/1.1 with an explicit Content-Length only, which is what the
 * core's client always sends. Exactly one request is served, then the
 * listener stops itself. Nothing terminates TLS here, and nothing leaves the
 * loopback interface except the single forward hop.
 */
final class TsaLoopbackRelay {
  /// Upper bound on a relayed timestamp query. RFC 3161 requests are a few
  /// hundred bytes; this only has to be larger than any honest one.
  private static let maxBodyBytes = 1 << 20

  /// Per-witness cap on the forward hop.
  private static let upstreamTimeout: TimeInterval = 15

  private let upstream: URL
  private let queue = DispatchQueue(label: "com.verify.camera.tsa-relay", qos: .userInitiated)
  private let listenerLock = NSLock()
  private var listenerStorage: NWListener?
  private var served = false

  private let errorLock = NSLock()
  private var lastErrorStorage: String?
  /// The relay-side failure, verbatim, or nil when the forward succeeded.
  /// Written before the error response is sent, read by the module after the
  /// core throws — the lock makes that cross-queue handoff safe.
  private(set) var lastError: String? {
    get { errorLock.lock(); defer { errorLock.unlock() }; return lastErrorStorage }
    set { errorLock.lock(); lastErrorStorage = newValue; errorLock.unlock() }
  }

  /// `stop()` runs both from the module's defer and from the response
  /// completion on `queue`, so the listener reference is lock-guarded too.
  private var listener: NWListener? {
    get { listenerLock.lock(); defer { listenerLock.unlock() }; return listenerStorage }
    set { listenerLock.lock(); listenerStorage = newValue; listenerLock.unlock() }
  }

  init(upstream: URL) {
    self.upstream = upstream
  }

  /// Starts the loopback listener and returns the URL to hand the SDK.
  /// Throws (recording lastError) when the listener cannot come up.
  func start() throws -> URL {
    let params = NWParameters.tcp
    // Loopback only — the relay must never be reachable off-device.
    params.requiredInterfaceType = .loopback
    let newListener: NWListener
    do {
      newListener = try NWListener(using: params, on: .any) // OS-assigned port
    } catch {
      lastError = "TSA relay: loopback listener could not be created: \(error.localizedDescription)"
      throw error
    }
    let ready = DispatchSemaphore(value: 0)
    var readyPort: NWEndpoint.Port?
    var startFailure: String?
    newListener.stateUpdateHandler = { [weak newListener] state in
      switch state {
      case .ready:
        readyPort = newListener?.port
        ready.signal()
      case .failed(let error):
        startFailure = error.localizedDescription
        ready.signal()
      case .cancelled:
        ready.signal()
      default:
        break
      }
    }
    newListener.newConnectionHandler = { [weak self] connection in
      self?.handle(connection: connection)
    }
    newListener.start(queue: queue)
    if ready.wait(timeout: .now() + 5) == .timedOut {
      newListener.cancel()
      lastError = "TSA relay: loopback listener did not become ready within 5s"
      throw NamedException("C2PA_SIGN", lastError!)
    }
    guard let port = readyPort else {
      newListener.cancel()
      lastError = "TSA relay: loopback listener failed to start: \(startFailure ?? "cancelled")"
      throw NamedException("C2PA_SIGN", lastError!)
    }
    self.listener = newListener
    return URL(string: "http://127.0.0.1:\(port.rawValue)/")!
  }

  /// Stops the listener. Idempotent; the module calls it in a defer so no
  /// relay survives its sign call.
  func stop() {
    listenerLock.lock()
    let current = listenerStorage
    listenerStorage = nil
    listenerLock.unlock()
    current?.cancel()
  }

  // MARK: - one-shot request handling (all on `queue`)

  private func handle(connection: NWConnection) {
    guard !served else { connection.cancel(); return }
    served = true
    connection.start(queue: queue)
    readHeaders(connection: connection, accumulating: Data())
  }

  private func readHeaders(connection: NWConnection, accumulating: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
      guard let self = self else { return }
      var buffer = accumulating
      if let data = data { buffer.append(data) }
      if let error = error {
        self.lastError = "TSA relay: reading the core's request failed: \(error.localizedDescription)"
        connection.cancel()
        return
      }
      guard let headerEnd = buffer.range(of: Data([13, 10, 13, 10])) else {
        if buffer.count > 65536 {
          self.lastError = "TSA relay: request headers exceeded 64 KB without terminating"
          self.respond(connection: connection, status: 400, contentType: "text/plain", body: Data())
        } else if isComplete {
          // The peer closed mid-header. Without this the receive returns
          // nil data and nil error forever and the recursion never ends.
          self.lastError = "TSA relay: the connection closed before the request headers finished"
          connection.cancel()
        } else {
          self.readHeaders(connection: connection, accumulating: buffer)
        }
        return
      }
      let headerText = String(decoding: buffer[..<headerEnd.lowerBound], as: UTF8.self)
      var contentLength: Int?
      for line in headerText.components(separatedBy: "\r\n") {
        let parts = line.split(separator: ":", maxSplits: 1)
        if parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
          contentLength = Int(parts[1].trimmingCharacters(in: .whitespaces))
        }
      }
      guard let length = contentLength else {
        self.lastError = "TSA relay: the core's POST carried no Content-Length (chunked is not supported)"
        self.respond(connection: connection, status: 400, contentType: "text/plain", body: Data())
        return
      }
      // Bound the declared length before it reaches prefix(_:), which traps
      // on a negative argument, or readBody, which would otherwise wait for
      // bytes that never arrive.
      guard length >= 0, length <= Self.maxBodyBytes else {
        self.lastError = "TSA relay: Content-Length \(length) is outside the accepted range (0…\(Self.maxBodyBytes))"
        self.respond(connection: connection, status: 400, contentType: "text/plain", body: Data())
        return
      }
      let body = Data(buffer[headerEnd.upperBound...])
      if body.count >= length {
        self.forward(connection: connection, body: Data(body.prefix(length)))
      } else {
        self.readBody(connection: connection, body: body, needed: length)
      }
    }
  }

  private func readBody(connection: NWConnection, body: Data, needed: Int) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: max(1, needed - body.count)) { [weak self] data, _, isComplete, error in
      guard let self = self else { return }
      var buffer = body
      if let data = data { buffer.append(data) }
      if let error = error {
        self.lastError = "TSA relay: reading the request body failed: \(error.localizedDescription)"
        connection.cancel()
        return
      }
      if buffer.count >= needed {
        self.forward(connection: connection, body: Data(buffer.prefix(needed)))
      } else if isComplete {
        // Same closed-early case as the header read.
        self.lastError = "TSA relay: the connection closed after \(buffer.count) of \(needed) body bytes"
        connection.cancel()
      } else {
        self.readBody(connection: connection, body: buffer, needed: needed)
      }
    }
  }

  /// The one network hop: RFC 3161 query → configured authority.
  private func forward(connection: NWConnection, body: Data) {
    var request = URLRequest(url: upstream)
    request.httpMethod = "POST"
    request.setValue("application/timestamp-query", forHTTPHeaderField: "Content-Type")
    request.httpBody = body
    // An authority that has not answered in this long is not going to. The
    // cap matters beyond patience: on a biometric capture the whole witness
    // pool has to finish inside the held-context TTL, and a 30s stall on the
    // first witness would spend it.
    request.timeoutInterval = Self.upstreamTimeout
    let done = DispatchSemaphore(value: 0)
    var responseData: Data?
    var httpResponse: HTTPURLResponse?
    var transportError: Error?
    let task = URLSession.shared.dataTask(with: request) { data, response, error in
      responseData = data
      httpResponse = response as? HTTPURLResponse
      transportError = error
      done.signal()
    }
    task.resume()
    if done.wait(timeout: .now() + Self.upstreamTimeout) == .timedOut {
      task.cancel()
      lastError = "TSA relay: upstream \(upstream.absoluteString) did not answer within \(Int(Self.upstreamTimeout))s"
      respond(connection: connection, status: 504, contentType: "text/plain", body: Data())
      return
    }
    if let transportError = transportError {
      lastError = "TSA relay: forward to \(upstream.absoluteString) failed: \(transportError.localizedDescription)"
      respond(connection: connection, status: 502, contentType: "text/plain", body: Data())
      return
    }
    guard let http = httpResponse else {
      lastError = "TSA relay: forward to \(upstream.absoluteString) returned no HTTP response"
      respond(connection: connection, status: 502, contentType: "text/plain", body: Data())
      return
    }
    if http.statusCode == 200, let data = responseData {
      // The content type the core requires, set only on a real upstream 200.
      // A non-200 upstream is relayed with its true status.
      respond(connection: connection, status: 200, contentType: "application/timestamp-reply", body: data)
    } else {
      lastError = "TSA relay: upstream \(upstream.absoluteString) responded HTTP \(http.statusCode)"
      respond(connection: connection, status: http.statusCode, contentType: "text/plain", body: responseData ?? Data())
    }
  }

  private func respond(connection: NWConnection, status: Int, contentType: String, body: Data) {
    let phrase: String
    switch status {
    case 200: phrase = "OK"
    case 400: phrase = "Bad Request"
    case 502: phrase = "Bad Gateway"
    case 504: phrase = "Gateway Timeout"
    default: phrase = "Upstream Error"
    }
    let head = "HTTP/1.1 \(status) \(phrase)\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
    var responseData = Data(head.utf8)
    responseData.append(body)
    connection.send(content: responseData, completion: .contentProcessed { [weak self] _ in
      connection.cancel()
      self?.stop() // one-shot: this relay served its single request
    })
  }
}
