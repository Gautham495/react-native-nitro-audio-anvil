import Foundation

/// Copies a media-time range out of one or more segment files into a new WAV.
enum RangeExtractor {
  static func extract(sources: [RangeSource], sampleRate: Int, startMs: Double, endMs: Double, to url: URL) throws {
    guard endMs > startMs else { throw AnvilError(.state, "endMs must be greater than startMs") }
    let bytesPerMs = Double(sampleRate * 2) / 1000.0
    guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
      throw AnvilError(.io, "Cannot create \(url.path)")
    }
    let output = try FileHandle(forWritingTo: url)
    defer { try? output.close() }
    try output.write(contentsOf: WavHeader.bytes(sampleRate: sampleRate, dataBytes: 0))
    var written = 0
    for source in sources {
      let sourceEndMs = source.mediaStartMs + Double(source.dataBytes) / bytesPerMs
      let overlapStart = max(startMs, source.mediaStartMs)
      let overlapEnd = min(endMs, sourceEndMs)
      guard overlapEnd > overlapStart else { continue }
      let fromByte = Int((overlapStart - source.mediaStartMs) * bytesPerMs) & ~1
      let toByte = min(source.dataBytes, Int((overlapEnd - source.mediaStartMs) * bytesPerMs) & ~1)
      guard toByte > fromByte else { continue }
      let input = try FileHandle(forReadingFrom: source.url)
      defer { try? input.close() }
      try input.seek(toOffset: UInt64(WavHeader.byteCount + fromByte))
      guard let bytes = try input.read(upToCount: toByte - fromByte) else { continue }
      try output.write(contentsOf: bytes)
      written += bytes.count
    }
    try WavHeader.patch(handle: output, dataBytes: written)
    try output.synchronize()
  }
}
