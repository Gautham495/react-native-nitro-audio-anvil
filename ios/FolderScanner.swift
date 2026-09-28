import Foundation

/// Walks `outputDirectory` for unsealed recording folders and returns them as
/// `RecoveredRecording`s. Repairs manifests on the way: verifies every referenced
/// segment exists and is valid ADTS, rolls unreferenced trailing `.aac` files into the
/// manifest if they parse, deletes them if they don't.
enum FolderScanner {
  static let manifestName = "manifest.m3u8"
  static let segmentExtension = "aac"
  static let sentinelExtension = "uploaded"

  static func discover(outputDirectory: URL) throws -> [RecoveredRecording] {
    let fm = FileManager.default
    guard fm.fileExists(atPath: outputDirectory.path) else { return [] }

    let subfolders = try fm.contentsOfDirectory(
      at: outputDirectory,
      includingPropertiesForKeys: [.isDirectoryKey],
      options: [.skipsHiddenFiles]
    ).filter { url in
      var isDir: ObjCBool = false
      fm.fileExists(atPath: url.path, isDirectory: &isDir)
      return isDir.boolValue
    }

    var recovered: [RecoveredRecording] = []
    for folder in subfolders {
      if let rec = try recoverFolder(folder) {
        recovered.append(rec)
      }
    }
    return recovered
  }

  private static func recoverFolder(_ folder: URL) throws -> RecoveredRecording? {
    let manifestURL = folder.appendingPathComponent(manifestName)
    guard let parsed = try HlsManifestReader.read(from: manifestURL), !parsed.sealed else {
      return nil
    }

    let fm = FileManager.default
    let allFiles = try fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey])
    let aacFiles = allFiles.filter { $0.pathExtension == segmentExtension }

    // Which entries were preceded by a discontinuity, keyed by filename — so we can
    // preserve that flag no matter what order we rebuild in.
    var discontinuityByName: [String: Bool] = [:]
    for entry in parsed.entries {
      discontinuityByName[entry.filename] = entry.precededByDiscontinuity
    }

    // ---- Build the authoritative set by INDEX, not by manifest order. ----
    // Every candidate segment on disk (referenced or not) is validated once. A file is
    // kept iff it parses as ADTS with >0 duration. Order is the numeric index parsed
    // from "%05d.aac" — this is the ONLY ordering source, which makes discovery
    // idempotent: the Nth and (N+1)th pass produce identical output.
    struct Candidate {
      let index: Int
      let url: URL
      let scan: AdtsFrameScanner.Scan
      let precededByDiscontinuity: Bool
    }

    var candidates: [Candidate] = []
    var manifestDirty = false

    for url in aacFiles {
      guard let index = segmentIndex(from: url.lastPathComponent) else {
        // A .aac whose name isn't our NNNNN.aac scheme — not ours, leave it alone.
        continue
      }
      guard let scan = try? AdtsFrameScanner.scan(url: url), scan.durationMs > 0 else {
        // Unparseable. If it was referenced, dropping it dirties the manifest.
        if discontinuityByName[url.lastPathComponent] != nil { manifestDirty = true }
        // Only delete files that were NEVER referenced — a referenced-but-now-broken
        // file might be mid-write by another process; deleting is too aggressive.
        // Unreferenced garbage is safe to remove.
        if discontinuityByName[url.lastPathComponent] == nil {
          try? fm.removeItem(at: url)
        }
        continue
      }

      // Torn tail: bytes after validByteCount are garbage. Truncate so disk == manifest
      // == what every reader (concat, hls.js, AVPlayer) sees. Idempotent: a file already
      // trimmed has validByteCount == length and this is a no-op.
      if scan.validByteCount < fileSize(of: url) {
        try truncate(url: url, to: scan.validByteCount)
        manifestDirty = true
      }

      let wasReferenced = discontinuityByName[url.lastPathComponent] != nil
      if !wasReferenced { manifestDirty = true }  // salvaged a new tail

      candidates.append(Candidate(
        index: index,
        url: url,
        scan: scan,
        precededByDiscontinuity: discontinuityByName[url.lastPathComponent] ?? false
      ))
    }

    guard !candidates.isEmpty else {
      // Nothing survives. Leave the (empty-ish) folder for the caller to delete via
      // deleteRecording; returning nil means "not an orphan worth surfacing".
      return nil
    }

    // THE FIX: sort by numeric index. Never by manifest position, never by append order.
    candidates.sort { $0.index < $1.index }

    // Rebuild segments + entries in index order, with a contiguous media timeline.
    var validEntries: [HlsManifestWriter.Entry] = []
    var segments: [RecordingSegment] = []
    var runningMediaStartMs: Double = 0
    var outIndex = 0

    for c in candidates {
      let entry = HlsManifestWriter.Entry(
        filename: c.url.lastPathComponent,
        durationSeconds: c.scan.durationMs / 1000.0,
        precededByDiscontinuity: c.precededByDiscontinuity
      )
      validEntries.append(entry)
      let segment = try materializeSegment(
        url: c.url,
        index: outIndex,
        sampleRate: c.scan.sampleRate,
        durationMs: c.scan.durationMs,
        mediaStartMs: runningMediaStartMs,
        precededByDiscontinuity: c.precededByDiscontinuity
      )
      segments.append(segment)
      runningMediaStartMs += c.scan.durationMs
      outIndex += 1
    }

    // Detect whether the manifest's stored order already matches ours. If the manifest
    // listed segments in a different order (a prior buggy pass), that's also dirty.
    if parsed.entries.map({ $0.filename }) != validEntries.map({ $0.filename }) {
      manifestDirty = true
    }

    if manifestDirty {
      let writer = HlsManifestWriter(folderURL: folder, targetDurationSeconds: parsed.targetDurationSeconds)
      writer.seed(existingEntries: validEntries, sealed: false)
      try writer.rewriteInPlace()
    }

    let totalDurationMs = segments.reduce(0.0) { $0 + $1.durationMs }
    let wasInterrupted = validEntries.contains { $0.precededByDiscontinuity }
    return RecoveredRecording(
      recordingId: folder.lastPathComponent,
      folderPath: folder.path,
      manifestPath: manifestURL.path,
      segments: segments,
      totalDurationMs: totalDurationMs,
      wasInterrupted: wasInterrupted
    )
  }

  /// Parses the numeric index from "NNNNN.aac". Returns nil for names that don't match.
  private static func segmentIndex(from filename: String) -> Int? {
    guard filename.hasSuffix(".\(segmentExtension)") else { return nil }
    let stem = String(filename.dropLast(segmentExtension.count + 1))
    // Must be all digits — rejects "manifest", ".sync", etc.
    guard !stem.isEmpty, stem.allSatisfy({ $0.isNumber }) else { return nil }
    return Int(stem)
  }

  private static func fileSize(of url: URL) -> Int {
    (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
  }

  /// Truncate a file to `length` bytes and fsync so the trim is durable before we
  /// reference it in the manifest.
  private static func truncate(url: URL, to length: Int) throws {
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.truncate(atOffset: UInt64(length))
    try handle.anvilFullSync()
  }

  /// Public seam used by resume-from-existing-manifest in the factory: builds a
  /// `RecordingSegment` from a file that's already on disk, using its ADTS scan and its
  /// filesystem attributes.
  static func materializeSegment(
    url: URL,
    index: Int,
    sampleRate: Int,
    durationMs: Double,
    mediaStartMs: Double,
    precededByDiscontinuity: Bool
  ) throws -> RecordingSegment {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    let fileSize = (attributes[.size] as? NSNumber)?.intValue ?? 0
    let created = (attributes[.creationDate] as? Date) ?? Date()
    let modified = (attributes[.modificationDate] as? Date) ?? created
    return RecordingSegment(
      index: Double(index),
      filename: url.lastPathComponent,
      filePath: url.path,
      sampleRate: Double(sampleRate),
      durationMs: durationMs,
      fileSize: Double(fileSize),
      mediaStartMs: mediaStartMs,
      startedAt: created.timeIntervalSince1970 * 1000,
      endedAt: modified.timeIntervalSince1970 * 1000,
      wasInterrupted: precededByDiscontinuity,
      interruptionReason: nil,
      routeChanged: false,
      sha256: try url.anvilSHA256Hex()
    )
  }
}


