import Foundation

/// Parses `manifest.m3u8` files Anvil wrote. Not a general HLS parser — only recognises
/// the tags Anvil emits.
enum HlsManifestReader {
  struct ParsedManifest {
    let targetDurationSeconds: Int
    let entries: [HlsManifestWriter.Entry]
    let sealed: Bool
    /// `true` when the LAST entry is preceded by a `#EXT-X-DISCONTINUITY` — the previous
    /// run ended on an interruption or route change, not a clean rotation.
    let lastEntryOnDiscontinuity: Bool
  }

  /// Returns `nil` when the file is not a valid Anvil-written manifest (missing header).
  static func read(from url: URL) throws -> ParsedManifest? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let contents = try String(contentsOf: url, encoding: .utf8)
    return parse(contents)
  }

  static func parse(_ contents: String) -> ParsedManifest? {
    let lines = contents.split(whereSeparator: { $0 == "\n" || $0 == "\r" }).map(String.init)
    guard lines.first == "#EXTM3U" else { return nil }

    var targetDurationSeconds = 6
    var entries: [HlsManifestWriter.Entry] = []
    var sealed = false
    var pendingDiscontinuity = false
    var pendingDurationSeconds: Double?

    for line in lines {
      if line.hasPrefix("#EXT-X-TARGETDURATION:") {
        let value = String(line.dropFirst("#EXT-X-TARGETDURATION:".count))
        if let parsed = Int(value) { targetDurationSeconds = max(1, parsed) }
      } else if line == "#EXT-X-DISCONTINUITY" {
        pendingDiscontinuity = true
      } else if line.hasPrefix("#EXTINF:") {
        let trimmed = String(line.dropFirst("#EXTINF:".count))
        let value = trimmed.split(separator: ",").first.map(String.init) ?? trimmed
        pendingDurationSeconds = Double(value)
      } else if line == "#EXT-X-ENDLIST" {
        sealed = true
      } else if !line.isEmpty, !line.hasPrefix("#") {
        // Bare segment filename line.
        let duration = pendingDurationSeconds ?? 0
        entries.append(HlsManifestWriter.Entry(
          filename: line,
          durationSeconds: duration,
          precededByDiscontinuity: pendingDiscontinuity
        ))
        pendingDiscontinuity = false
        pendingDurationSeconds = nil
      }
    }

    let lastOnDiscontinuity = entries.last?.precededByDiscontinuity ?? false
    return ParsedManifest(
      targetDurationSeconds: targetDurationSeconds,
      entries: entries,
      sealed: sealed,
      lastEntryOnDiscontinuity: lastOnDiscontinuity
    )
  }
}
