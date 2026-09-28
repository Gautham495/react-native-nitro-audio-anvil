import Foundation

/// One open ADTS AAC segment file. Appends encoded frames and fsyncs on an interval.
/// Every fsync point produces a file that is a complete, playable AAC stream — ADTS is
/// self-synchronising so a torn write at the tail is simply ignored by decoders.
final class AacSegmentWriter {
  let index: Int
  let url: URL
  let sampleRate: Int
  let mediaStartMs: Double
  let startedAt: Double
  var wasInterrupted = false
  var interruptionReason: AnvilInterruptionReason?
  var routeChanged = false

  private let handle: FileHandle
  private let fsyncEveryBytes: Int
  private(set) var dataBytes = 0
  private(set) var pcmSamples = 0
  private var bytesSinceFlush = 0

  init(url: URL, index: Int, sampleRate: Int, mediaStartMs: Double, fsyncIntervalMs: Double, aacBitrate: Int) throws {
    self.url = url
    self.index = index
    self.sampleRate = sampleRate
    self.mediaStartMs = mediaStartMs
    self.startedAt = Date().timeIntervalSince1970 * 1000

    // Bytes per ms at the encoded bitrate; fsync boundary in bytes = time budget * rate.
    let bytesPerMs = Double(aacBitrate) / 8000.0
    self.fsyncEveryBytes = max(1024, Int(bytesPerMs * fsyncIntervalMs))

    guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
      throw AnvilError(.io, "Cannot create \(url.path)")
    }
    handle = try FileHandle(forWritingTo: url)
  }

  /// Duration derived from PCM samples fed, not from byte size (byte size varies with
  /// bitrate and VBR jitter; sample count is exact).
  var durationMs: Double {
    Double(pcmSamples) / Double(sampleRate) * 1000.0
  }

  func append(frame: AacEncoder.Frame) throws {
    _ = try handle.seekToEnd()
    try handle.write(contentsOf: frame.bytes)
    dataBytes += frame.bytes.count
    pcmSamples += frame.pcmSamples
    bytesSinceFlush += frame.bytes.count
    if bytesSinceFlush >= fsyncEveryBytes {
      try flush()
    }
  }

  /// `F_FULLFSYNC` on the segment file — actually pushes bytes to storage on iOS.
  func flush() throws {
    try handle.anvilFullSync()
    bytesSinceFlush = 0
  }

  func finalize() throws -> RecordingSegment {
    try flush()
    try handle.close()
    let filename = url.lastPathComponent
    let sha = try url.anvilSHA256Hex()
    return RecordingSegment(
      index: Double(index),
      filename: filename,
      filePath: url.path,
      sampleRate: Double(sampleRate),
      durationMs: durationMs,
      fileSize: Double(dataBytes),
      mediaStartMs: mediaStartMs,
      startedAt: startedAt,
      endedAt: Date().timeIntervalSince1970 * 1000,
      wasInterrupted: wasInterrupted,
      interruptionReason: interruptionReason,
      routeChanged: routeChanged,
      sha256: sha
    )
  }

  /// Best-effort close when `finalize()` failed. Bytes up to the last flush stay
  /// playable; the file may end mid-frame but ADTS-aware decoders ignore the tail.
  func abandon() {
    try? flush()
    try? handle.close()
  }
}
