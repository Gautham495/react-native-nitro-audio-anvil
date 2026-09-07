import Foundation

/// Finds sessions whose `.recording` marker is still present (the app died before `stop()`),
/// repairs their WAV headers from the real file length, hashes them and removes the marker.
enum OrphanScanner {
  static let markerExtension = "recording"

  static func markerURL(directory: URL, sessionId: String) -> URL {
    directory.appendingPathComponent("\(sessionId).\(markerExtension)")
  }

  static func discover(directory: URL) throws -> [OrphanedRecording] {
    let fileManager = FileManager.default
    guard fileManager.fileExists(atPath: directory.path) else { return [] }
    let entries = try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
    let markers = entries.filter { $0.pathExtension == markerExtension }
    var result: [OrphanedRecording] = []
    for marker in markers {
      let sessionId = marker.deletingPathExtension().lastPathComponent
      let files = entries
        .filter { $0.pathExtension == "wav" && $0.lastPathComponent.hasPrefix("\(sessionId)-") }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
      var segments: [RecordingSegment] = []
      var mediaStartMs = 0.0
      for (index, file) in files.enumerated() {
        guard let segment = try repair(file: file, index: index, mediaStartMs: mediaStartMs) else { continue }
        segments.append(segment)
        mediaStartMs += segment.durationMs
      }
      try? fileManager.removeItem(at: marker)
      result.append(OrphanedRecording(sessionId: sessionId, segments: segments))
    }
    return result
  }

  private static func repair(file: URL, index: Int, mediaStartMs: Double) throws -> RecordingSegment? {
    guard let header = try WavHeader.read(from: file) else { return nil }
    let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
    let fileSize = (attributes[.size] as? NSNumber)?.intValue ?? 0
    let actualDataBytes = max(0, fileSize - WavHeader.byteCount) & ~1
    if actualDataBytes != header.dataBytes {
      let handle = try FileHandle(forWritingTo: file)
      defer { try? handle.close() }
      try WavHeader.patch(handle: handle, dataBytes: actualDataBytes)
      try handle.synchronize()
    }
    let durationMs = Double(actualDataBytes) / Double(header.sampleRate * 2) * 1000.0
    let created = (attributes[.creationDate] as? Date) ?? Date()
    let modified = (attributes[.modificationDate] as? Date) ?? created
    return RecordingSegment(
      index: Double(index),
      filePath: file.path,
      sampleRate: Double(header.sampleRate),
      durationMs: durationMs,
      fileSize: Double(WavHeader.byteCount + actualDataBytes),
      mediaStartMs: mediaStartMs,
      startedAt: created.timeIntervalSince1970 * 1000,
      endedAt: modified.timeIntervalSince1970 * 1000,
      wasInterrupted: false,
      interruptionReason: nil,
      routeChanged: false,
      sha256: try file.anvilSHA256Hex()
    )
  }
}
