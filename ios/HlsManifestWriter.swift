import Foundation

/// Owns the `manifest.m3u8` inside one recording folder. Every write is atomic:
/// write to `.tmp`, F_FULLFSYNC, rename, then F_FULLFSYNC the containing dir.
///
/// The manifest is the source of truth for the recording. `#EXT-X-ENDLIST` marks it
/// sealed; anything on disk that isn't referenced by the manifest is either an in-progress
/// tail (still being written) or garbage the orphan scanner will handle.
final class HlsManifestWriter {
  private let manifestURL: URL
  private let tempURL: URL
  private let folderURL: URL
  private let targetDurationSeconds: Int
  private var entries: [Entry] = []
  private var pendingDiscontinuity = false
  private var sealed = false

  /// One `#EXTINF,` + filename entry, plus its optional `#EXT-X-DISCONTINUITY` predecessor.
  struct Entry {
    let filename: String
    let durationSeconds: Double
    let precededByDiscontinuity: Bool
  }

  var manifestPath: String { manifestURL.path }

  init(folderURL: URL, targetDurationSeconds: Int) {
    self.folderURL = folderURL
    self.manifestURL = folderURL.appendingPathComponent("manifest.m3u8")
    self.tempURL = folderURL.appendingPathComponent("manifest.m3u8.tmp")
    self.targetDurationSeconds = max(1, targetDurationSeconds)
  }

  /// Seed from a parsed manifest — used on resume so future appends know the current
  /// segment count and target duration.
  func seed(existingEntries: [Entry], sealed: Bool) {
    self.entries = existingEntries
    self.sealed = sealed
  }

  /// Insert a `#EXT-X-DISCONTINUITY` before the next `appendSegment(...)` call. Idempotent
  /// — repeated calls before a segment write still result in exactly one discontinuity.
  func markDiscontinuity() {
    pendingDiscontinuity = true
  }

  /// Adds one segment to the manifest and rewrites the file. `filename` is relative to
  /// the folder; `durationMs` becomes the `#EXTINF` value in seconds with millisecond
  /// precision.
  func appendSegment(filename: String, durationMs: Double) throws {
    guard !sealed else {
      throw AnvilError(.state, "Cannot append to sealed manifest")
    }
    let entry = Entry(
      filename: filename,
      durationSeconds: durationMs / 1000.0,
      precededByDiscontinuity: pendingDiscontinuity
    )
    pendingDiscontinuity = false
    entries.append(entry)
    try writeAtomically(sealed: false)
  }

  /// Appends `#EXT-X-ENDLIST` and rewrites. Idempotent.
  func seal() throws {
    guard !sealed else { return }
    sealed = true
    try writeAtomically(sealed: true)
  }

  /// Rewrites the manifest to reflect the currently-seeded entries. Used by the folder
  /// scanner after it repairs a manifest during discovery — the seed is authoritative
  /// and we just need to persist it.
  func rewriteInPlace() throws {
    try writeAtomically(sealed: sealed)
  }

  private func writeAtomically(sealed: Bool) throws {
    let contents = render(sealed: sealed)
    // Ensure no stale .tmp — a previous crash could have left one.
    try? FileManager.default.removeItem(at: tempURL)
    guard FileManager.default.createFile(atPath: tempURL.path, contents: nil) else {
      throw AnvilError(.io, "Cannot create \(tempURL.path)")
    }
    let handle = try FileHandle(forWritingTo: tempURL)
    do {
      try handle.write(contentsOf: Data(contents.utf8))
      try handle.anvilFullSync()
      try handle.close()
    } catch {
      try? handle.close()
      throw error
    }

    // Rename over the target atomically. `replaceItemAt` handles both the "target
    // exists" and "target does not exist" cases and is atomic on both APFS and HFS+.
    try FileManager.default.replaceItem(
      at: manifestURL,
      withItemAt: tempURL,
      backupItemName: nil,
      options: [],
      resultingItemURL: nil
    )

    // Fsync the directory so the rename itself survives power loss.
    try folderURL.anvilFullSyncDirectory()
  }

  private func render(sealed: Bool) -> String {
    var lines: [String] = []
    lines.append("#EXTM3U")
    lines.append("#EXT-X-VERSION:3")
    lines.append("#EXT-X-TARGETDURATION:\(targetDurationSeconds)")
    lines.append("#EXT-X-MEDIA-SEQUENCE:0")
    for entry in entries {
      if entry.precededByDiscontinuity {
        lines.append("#EXT-X-DISCONTINUITY")
      }
      lines.append(String(format: "#EXTINF:%.3f,", entry.durationSeconds))
      lines.append(entry.filename)
    }
    if sealed {
      lines.append("#EXT-X-ENDLIST")
    }
    return lines.joined(separator: "\n") + "\n"
  }
}
