import Foundation

/// Tiny zero-byte marker files that record which segments have been PUT to the bucket.
/// `${filename}.uploaded` sits next to `${filename}` and its mere presence is the signal.
///
/// The manifest gets one too — `manifest.m3u8.uploaded` — but manifests are re-PUT on
/// every segment upload anyway, so its role is only to close out fully-uploaded sealed
/// folders for local cleanup.
enum UploadSentinelStore {
  static let sentinelSuffix = ".uploaded"

  static func sentinelURL(folder: URL, filename: String) -> URL {
    folder.appendingPathComponent(filename + sentinelSuffix)
  }

  static func exists(folder: URL, filename: String) -> Bool {
    FileManager.default.fileExists(atPath: sentinelURL(folder: folder, filename: filename).path)
  }

  /// Idempotent. Writes a zero-byte file if one doesn't exist.
  static func mark(folder: URL, filename: String) throws {
    let url = sentinelURL(folder: folder, filename: filename)
    if FileManager.default.fileExists(atPath: url.path) { return }
    guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
      throw AnvilError(.io, "Cannot create sentinel \(url.lastPathComponent)")
    }
  }

  static func listPending(outputDirectory: URL) throws -> [PendingUpload] {
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

    var pending: [PendingUpload] = []
    for folder in subfolders {
      let recordingId = folder.lastPathComponent
      let manifestURL = folder.appendingPathComponent(FolderScanner.manifestName)
      guard let parsed = try HlsManifestReader.read(from: manifestURL) else { continue }

      for entry in parsed.entries {
        if exists(folder: folder, filename: entry.filename) { continue }
        let segURL = folder.appendingPathComponent(entry.filename)
        guard fm.fileExists(atPath: segURL.path) else { continue }
        let attributes = try fm.attributesOfItem(atPath: segURL.path)
        let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
        pending.append(PendingUpload(
          recordingId: recordingId,
          kind: .segment,
          filename: entry.filename,
          filePath: segURL.path,
          fileSize: Double(size)
        ))
      }

      if !exists(folder: folder, filename: FolderScanner.manifestName),
         fm.fileExists(atPath: manifestURL.path) {
        let attributes = try fm.attributesOfItem(atPath: manifestURL.path)
        let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
        pending.append(PendingUpload(
          recordingId: recordingId,
          kind: .manifest,
          filename: FolderScanner.manifestName,
          filePath: manifestURL.path,
          fileSize: Double(size)
        ))
      }
    }
    return pending
  }
}
