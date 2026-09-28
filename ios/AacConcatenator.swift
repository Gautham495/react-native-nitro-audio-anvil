import Foundation

/// Joins every segment referenced by a recording's manifest into a single ADTS AAC file.
/// Byte-copy — ADTS is self-synchronising so concatenating frame streams is legal.
enum AacConcatenator {
  static func concatenate(folder: URL, output: URL) throws -> RecordingSegment {
    let manifestURL = folder.appendingPathComponent(FolderScanner.manifestName)
    guard let parsed = try HlsManifestReader.read(from: manifestURL) else {
      throw AnvilError(.state, "\(folder.lastPathComponent)/manifest.m3u8 is missing or invalid")
    }
    guard !parsed.entries.isEmpty else {
      throw AnvilError(.state, "\(folder.lastPathComponent) has no segments")
    }

    let fm = FileManager.default
    guard fm.createFile(atPath: output.path, contents: nil) else {
      throw AnvilError(.io, "Cannot create \(output.path)")
    }
    let out = try FileHandle(forWritingTo: output)
    defer { try? out.close() }

    let startedAt = Date().timeIntervalSince1970 * 1000
    var totalBytes = 0
    var totalDurationMs = 0.0
    var sampleRate = 0

    for entry in parsed.entries {
      let segURL = folder.appendingPathComponent(entry.filename)
      guard let scan = try AdtsFrameScanner.scan(url: segURL) else {
        throw AnvilError(.io, "\(entry.filename) is not a valid ADTS AAC file")
      }
      if sampleRate == 0 { sampleRate = scan.sampleRate }
      guard scan.sampleRate == sampleRate else {
        throw AnvilError(.state, "\(entry.filename) is \(scan.sampleRate) Hz, expected \(sampleRate) Hz")
      }
      let reader = try FileHandle(forReadingFrom: segURL)
      defer { try? reader.close() }
      var remaining = scan.validByteCount
      while remaining > 0 {
        guard let chunk = try reader.read(upToCount: min(remaining, 1 << 20)), !chunk.isEmpty else { break }
        try out.write(contentsOf: chunk)
        totalBytes += chunk.count
        remaining -= chunk.count
      }
      totalDurationMs += scan.durationMs
    }
    try out.anvilFullSync()

    return RecordingSegment(
      index: 0,
      filename: output.lastPathComponent,
      filePath: output.path,
      sampleRate: Double(sampleRate),
      durationMs: totalDurationMs,
      fileSize: Double(totalBytes),
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
