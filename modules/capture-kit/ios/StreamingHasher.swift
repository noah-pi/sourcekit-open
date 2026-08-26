// Source Kit 0.1.0 — chunked SHA-256 + Merkle root
// Written with AI assistance. Verification: docs/PROVENANCE.md.
import Foundation
import CryptoKit

/**
 * StreamingHasher — chunked SHA-256 + Merkle root (SPEC §3).
 * LEGACY (0.11.x) — read this before trusting any root. Now these
 * roots are NO LONGER consumed for new seals: v2 delivery-file roots are
 * computed at seal time and carry the commitment. This machinery remains
 * only so 0.11.x records stay reproducible, and its actual coverage is:
 * VIDEO commits NOTHING. Capture frames are CVPixelBuffer-backed with
 * no CMBlockBuffer, so the caller's CMSampleBufferGetDataBuffer guard
 * is always nil and the video root is always the documented
 * empty-stream SHA-256 with 0 chunks.
 * AUDIO commits the pre-encode native LPCM sample stream handed to the
 * AAC encoder — NOT the compressed AAC bytes stored in the delivery
 * file. It is a commitment to what the mic delivered, not to the file.
 * No delivery (compressed H.264/AAC) byte is ever hashed by this class.
 * Mechanics: bytes are grouped into fixed 1 MiB LOGICAL chunks over the
 * concatenated per-track byte stream; each completed chunk is committed as:
 * chunkDigest = SHA-256( trackId || chunkIndex || bytes)
 * trackId — UTF-8 "video" / "audio" (see HashTrack.idBytes)
 * chunkIndex — UInt64 big-endian, per track, from 0
 * bytes — exactly the chunk's bytes, in append order
 * A trailing partial chunk (< 1 MiB) is committed the same way on finalize —
 * otherwise the tail of the take would be uncommitted.
 * The Merkle root is a binary tree over the chunk digests in global
 * completion order (the order chunks finished, which is append order):
 * leaves are the RAW 32-byte digests (never hex), an odd leaf is promoted
 * unchanged to the next level, parent = SHA-256(left || right). A single
 * leaf is its own root. Zero chunks → SHA-256 of the empty input (documented
 * so the desk can reproduce it). Root is emitted lowercase hex.
 * Memory bound (SPEC §3): at most one in-flight chunk buffer per track
 * (≤ 1 MiB each) plus 32 bytes per committed chunk for the Merkle leaves
 * (~8 KiB for a 120 s take). Nothing scales with file length.
 * Thread confinement: all methods are called from the module's single serial
 * session queue. Not internally synchronized.
 */
final class StreamingHasher {

  struct ChunkCommit {
    let index: Int        // global completion index, 0-based
    let bytes: Int        // actual bytes in this chunk (== chunkBytes unless tail)
    let sha256Hex: String // lowercase hex of the raw digest
  }

  /// Fires for EVERY committed chunk, on the caller's queue (SPEC §3: every
  /// chunk must reach JS by stop; at 1 MiB chunks this is ≤ ~2/s at typical
  /// bitrates, well under any coalescing need).
  var onChunk: ((ChunkCommit) -> Void)?

  let chunkBytes: Int

  private var nextGlobalIndex = 0
  private var leaves: [Data] = []          // raw 32-byte digests, completion order
  private(set) var chunkCount = 0
  private var finalized = false

  private var video: TrackState
  private var audio: TrackState

  init(chunkBytes: Int = kCaptureKitChunkBytes) {
    self.chunkBytes = chunkBytes
    self.video = TrackState(track: .video, chunkBytes: chunkBytes)
    self.audio = TrackState(track: .audio, chunkBytes: chunkBytes)
  }

  // MARK: - Per-track state

  private final class TrackState {
    let track: HashTrack
    let chunkBytes: Int
    var chunkIndex: UInt64 = 0
    var hasher: SHA256?
    var buffered = 0

    init(track: HashTrack, chunkBytes: Int) {
      self.track = track
      self.chunkBytes = chunkBytes
    }

    /// Starts a fresh chunk hasher pre-loaded with the wire-format prefix:
    /// trackId (UTF-8) || chunkIndex (UInt64 big-endian).
    private func makeHasher(index: UInt64) -> SHA256 {
      var h = SHA256()
      h.update(data: Data(track.idBytes))
      var be = index.bigEndian
      withUnsafeBytes(of: &be) { h.update(bufferPointer: $0) }
      return h
    }

    /// Appends bytes, completing as many full chunks as the data spans.
    /// Returns the digests of chunks completed by this call.
    func append(_ bytes: UnsafeRawBufferPointer) -> [(digest: Data, bytes: Int)] {
      var completed: [(Data, Int)] = []
      var offset = 0
      while offset < bytes.count {
        if hasher == nil { hasher = makeHasher(index: chunkIndex) }
        let room = chunkBytes - buffered
        let take = min(room, bytes.count - offset)
        if let base = bytes.baseAddress {
          hasher!.update(bufferPointer: UnsafeRawBufferPointer(start: base + offset, count: take))
        }
        buffered += take
        offset += take
        if buffered == chunkBytes, let h = hasher {
          completed.append((Data(h.finalize()), chunkBytes))
          hasher = nil
          buffered = 0
          chunkIndex &+= 1
        }
      }
      return completed
    }

    /// Commits the trailing partial chunk, if any (SPEC §3: the tail of the
    /// take must be hashed too, with its actual byte count).
    func finish() -> (digest: Data, bytes: Int)? {
      guard buffered > 0, let h = hasher else { return nil }
      let out = (Data(h.finalize()), buffered)
      hasher = nil
      buffered = 0
      chunkIndex &+= 1
      return out
    }
  }

  // MARK: - Feeding

  /// Feed captured bytes for one track (legacy 0.11.x stream — see the class
  /// header). Video is never called with data (capture frames have no
  /// CMBlockBuffer); audio receives pre-encode native LPCM, not file bytes.
  func append(track: HashTrack, bytes: UnsafeRawBufferPointer) {
    guard !finalized, bytes.count > 0 else { return }
    let state = track == .video ? video : audio
    for chunk in state.append(bytes) {
      commit(digest: chunk.digest, bytes: chunk.bytes)
    }
  }

  /// Convenience overload for contiguous Data.
  func append(track: HashTrack, data: Data) {
    data.withUnsafeBytes { append(track: track, bytes: $0) }
  }

  // MARK: - Finalize

  /// Flushes trailing partial chunks on both tracks. Idempotent.
  func finalize() {
    guard !finalized else { return }
    finalized = true
    if let tail = video.finish() { commit(digest: tail.digest, bytes: tail.bytes) }
    if let tail = audio.finish() { commit(digest: tail.digest, bytes: tail.bytes) }
  }

  private func commit(digest: Data, bytes: Int) {
    let hex = digest.map { String(format: "%02x", $0) }.joined()
    let commit = ChunkCommit(index: nextGlobalIndex, bytes: bytes, sha256Hex: hex)
    nextGlobalIndex += 1
    chunkCount += 1
    leaves.append(digest)
    onChunk?(commit)
  }

  // MARK: - Merkle

 /**
 * Binary Merkle root over chunk digests in completion order.
 * Leaves are raw 32-byte digests; an odd leaf is promoted unchanged;
 * parent = SHA-256(left || right). Lowercase hex out (SPEC §3).
 */
  func merkleRootHex() -> String {
    var level = leaves
    if level.isEmpty {
      // Documented degenerate case: SHA-256 of empty input. For the video
      // track this is ALWAYS the outcome — see the class header.
      return Data(SHA256.hash(data: Data())).map { String(format: "%02x", $0) }.joined()
    }
    while level.count > 1 {
      var next: [Data] = []
      next.reserveCapacity((level.count + 1) / 2)
      var i = 0
      while i < level.count {
        if i + 1 < level.count {
          var h = SHA256()
          h.update(data: level[i])
          h.update(data: level[i + 1])
          next.append(Data(h.finalize()))
        } else {
          next.append(level[i]) // odd leaf promoted unchanged (SPEC §3)
        }
        i += 2
      }
      level = next
    }
    return level[0].map { String(format: "%02x", $0) }.joined()
  }
}
