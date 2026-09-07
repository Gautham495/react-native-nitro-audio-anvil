import Foundation

/// Streams the PCM payload of several WAV files into one WAV. Inputs must share a sample rate.
enum WavConcatenator {
  static func concatenate(inputs: [URL], output: URL) throws -> RecordingSegment {
    guard !inputs.isEmpty else { throw AnvilError(.state, "segmentPaths is empty") }
    let fileManager = FileManager.default
    guard fileManager.createFile(atPath: output.path, contents: nil) else {
      throw AnvilError(.io, "Cannot create \(output.path)")
    }
    let out = try FileHandle(forWritingTo: output)
    defer { try? out.close() }
    let startedAt = Date().timeIntervalSince1970 * 1000
    var sampleRate = 0
    var written = 0
    for input in inputs {
      guard let header = try WavHeader.read(from: input) else {
        throw AnvilError(.io, "\(input.lastPathComponent) is not a WAV file")
      }
      if sampleRate == 0 {
        sampleRate = header.sampleRate
        try out.write(contentsOf: WavHeader.bytes(sampleRate: sampleRate, dataBytes: 0))
      }
      guard header.sampleRate == sampleRate else {
        throw AnvilError(.state, "\(input.lastPathComponent) is \(header.sampleRate) Hz, expected \(sampleRate) Hz")
      }
      let attributes = try fileManager.attributesOfItem(atPath: input.path)
      let fileSize = (attributes[.size] as? NSNumber)?.intValue ?? 0
      let available = max(0, fileSize - WavHeader.byteCount) & ~1
      let dataBytes = header.dataBytes > 0 ? min(header.dataBytes, available) : available
      let reader = try FileHandle(forReadingFrom: input)
      defer { try? reader.close() }
      try reader.seek(toOffset: UInt64(WavHeader.byteCount))
      var remaining = dataBytes
      while remaining > 0 {
        guard let chunk = try reader.read(upToCount: min(remaining, 1 << 20)), !chunk.isEmpty else { break }
        try out.write(contentsOf: chunk)
        written += chunk.count
        remaining -= chunk.count
      }
    }
    try WavHeader.patch(handle: out, dataBytes: written)
    try out.synchronize()
    return RecordingSegment(
      index: 0,
      filePath: output.path,
      sampleRate: Double(sampleRate),
      durationMs: Double(written) / Double(sampleRate * 2) * 1000.0,
      fileSize: Double(WavHeader.byteCount + written),
      mediaStartMs: 0,
      startedAt: startedAt,
      endedAt: Date().timeIntervalSince1970 * 1000,
      wasInterrupted: false,
      interruptionReason: nil,
      routeChanged: false,
      sha256: try output.anvilSHA256Hex()
    )
  }
}
