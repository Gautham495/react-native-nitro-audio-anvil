import Foundation

/// One open WAV segment. Appends PCM, patches the header and fsyncs on an interval,
/// so the file on disk is a valid WAV at every flush point.
final class WavSegmentWriter {
  let index: Int
  let url: URL
  let sampleRate: Int
  let mediaStartMs: Double
  let startedAt: Double
  var wasInterrupted = false
  var interruptionReason: InterruptionReason?
  var routeChanged = false

  private let handle: FileHandle
  private let fsyncEveryBytes: Int
  private(set) var dataBytes = 0
  private var bytesSinceFlush = 0

  init(url: URL, index: Int, sampleRate: Int, mediaStartMs: Double, fsyncIntervalMs: Double) throws {
    self.url = url
    self.index = index
    self.sampleRate = sampleRate
    self.mediaStartMs = mediaStartMs
    self.startedAt = Date().timeIntervalSince1970 * 1000
    let bytesPerMs = Double(sampleRate * 2) / 1000.0
    self.fsyncEveryBytes = max(2, Int(bytesPerMs * fsyncIntervalMs))
    guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
      throw AnvilError(.io, "Cannot create \(url.path)")
    }
    handle = try FileHandle(forWritingTo: url)
    try handle.write(contentsOf: WavHeader.bytes(sampleRate: sampleRate, dataBytes: 0))
    try handle.synchronize()
  }

  var durationMs: Double {
    Double(dataBytes) / Double(sampleRate * 2) * 1000.0
  }

  func append(_ pcm: Data) throws {
    _ = try handle.seekToEnd()
    try handle.write(contentsOf: pcm)
    dataBytes += pcm.count
    bytesSinceFlush += pcm.count
    if bytesSinceFlush >= fsyncEveryBytes {
      try flush()
    }
  }

  /// Patches the header, then fsyncs. Header and data are consistent on disk afterwards.
  func flush() throws {
    try WavHeader.patch(handle: handle, dataBytes: dataBytes)
    try handle.synchronize()
    bytesSinceFlush = 0
  }

  func finalize() throws -> RecordingSegment {
    try flush()
    try handle.close()
    let sha = try url.anvilSHA256Hex()
    return RecordingSegment(
      index: Double(index),
      filePath: url.path,
      sampleRate: Double(sampleRate),
      durationMs: durationMs,
      fileSize: Double(WavHeader.byteCount + dataBytes),
      mediaStartMs: mediaStartMs,
      startedAt: startedAt,
      endedAt: Date().timeIntervalSince1970 * 1000,
      wasInterrupted: wasInterrupted,
      interruptionReason: interruptionReason,
      routeChanged: routeChanged,
      sha256: sha
    )
  }

  /// Best-effort close when `finalize()` itself failed. The file stays valid up to the last flush.
  func abandon() {
    try? flush()
    try? handle.close()
  }
}
