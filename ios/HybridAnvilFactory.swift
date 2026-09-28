import AVFoundation
import Foundation
import NitroModules

/// Autolinked root object. Creates recorders, answers permission questions, recovers
/// orphaned recordings, concatenates and deletes folders, drives the upload retry list.
final class HybridAnvilFactory: HybridAnvilFactorySpec {
  private static let queue = DispatchQueue(label: "ai.nitroaudio.anvil.factory")

  func createRecorder(config: RecorderConfig) throws -> Promise<any HybridAnvilRecorderSpec> {
    return Promise.parallel(Self.queue) { () throws -> any HybridAnvilRecorderSpec in
      try RecorderConfigValidator.validate(config)

      let outputDirectory = URL.anvilDirectory(config.outputDirectory)
      let folderURL = outputDirectory.appendingPathComponent(config.recordingId)
      let manifestURL = folderURL.appendingPathComponent(FolderScanner.manifestName)
      let manifestExists = FileManager.default.fileExists(atPath: manifestURL.path)

      let resume = config.resume ?? false

      if manifestExists {
        guard let parsed = try HlsManifestReader.read(from: manifestURL) else {
          throw AnvilError(.state, "\(config.recordingId)/manifest.m3u8 is present but unreadable")
        }
        if parsed.sealed {
          throw AnvilError(.state, "\(config.recordingId) is already sealed; use a fresh recordingId")
        }
        if !resume {
          throw AnvilError(.state, "\(config.recordingId) has an unsealed manifest; pass resume: true or deleteRecording(...)")
        }
        return try Self.buildResumedRecorder(config: config, folderURL: folderURL, parsed: parsed)
      }

      if resume {
        throw AnvilError(.state, "\(config.recordingId) has no manifest to resume from")
      }
      return HybridAnvilRecorder(
        config: config,
        seededSegments: [],
        seededNextIndex: 0,
        seededMediaMs: 0,
        resumingFromExisting: false
      )
    }
  }

  private static func buildResumedRecorder(
    config: RecorderConfig,
    folderURL: URL,
    parsed: HlsManifestReader.ParsedManifest
  ) throws -> HybridAnvilRecorder {
    var segments: [RecordingSegment] = []
    var runningMediaStartMs: Double = 0
    var runningIndex = 0
    var manifestSampleRate = 0

    for entry in parsed.entries {
      let url = folderURL.appendingPathComponent(entry.filename)
      guard let scan = try AdtsFrameScanner.scan(url: url), scan.durationMs > 0 else { continue }
      if manifestSampleRate == 0 { manifestSampleRate = scan.sampleRate }
      let segment = try FolderScanner.materializeSegment(
        url: url,
        index: runningIndex,
        sampleRate: scan.sampleRate,
        durationMs: scan.durationMs,
        mediaStartMs: runningMediaStartMs,
        precededByDiscontinuity: entry.precededByDiscontinuity
      )
      segments.append(segment)
      runningMediaStartMs += scan.durationMs
      runningIndex += 1
    }
    if manifestSampleRate != 0, manifestSampleRate != Int(config.sampleRate) {
      throw AnvilError(
        .state,
        "resume: existing manifest is \(manifestSampleRate) Hz, config is \(Int(config.sampleRate)) Hz"
      )
    }

    // The next write index MUST come from the highest filename number ACTUALLY ON DISK,
    // not from the count of scan-survivors. Every .aac in the folder counts — referenced,
    // unreferenced, torn, whatever. Reusing a filename would make AacSegmentWriter
    // truncate an existing segment on open. This is the bug that ate segments across
    // repeated recoveries.
    let nextIndex = try Self.highestSegmentIndexOnDisk(folderURL: folderURL) + 1

    return HybridAnvilRecorder(
      config: config,
      seededSegments: segments,
      seededNextIndex: nextIndex,
      seededMediaMs: runningMediaStartMs,
      resumingFromExisting: true,
      seededManifestEntries: parsed.entries
    )
  }

  /// Highest numeric index among all NNNNN.aac files physically present in the folder.
  /// Returns -1 when there are none (so caller's +1 yields 0).
  private static func highestSegmentIndexOnDisk(folderURL: URL) throws -> Int {
    let fm = FileManager.default
    let files = (try? fm.contentsOfDirectory(at: folderURL, includingPropertiesForKeys: nil)) ?? []
    var maxIndex = -1
    for url in files where url.pathExtension == FolderScanner.segmentExtension {
      let stem = url.deletingPathExtension().lastPathComponent
      guard !stem.isEmpty, stem.allSatisfy({ $0.isNumber }), let n = Int(stem) else { continue }
      if n > maxIndex { maxIndex = n }
    }
    return maxIndex
  }

  func getPermissionStatus() throws -> AnvilPermissionStatus {
    return AVAudioSession.sharedInstance().anvilPermissionStatus
  }

  func requestPermission() throws -> Promise<AnvilPermissionStatus> {
    return Promise.async { await AVAudioSession.anvilRequestPermission() }
  }

  func discoverOrphanedRecordings(outputDirectory: String) throws -> Promise<[RecoveredRecording]> {
    return Promise.parallel(Self.queue) {
      try FolderScanner.discover(outputDirectory: URL.anvilDirectory(outputDirectory))
    }
  }

  func concatenate(outputDirectory: String, recordingId: String, outputPath: String) throws -> Promise<RecordingSegment> {
    return Promise.parallel(Self.queue) {
      let folder = URL.anvilDirectory(outputDirectory).appendingPathComponent(recordingId)
      return try AacConcatenator.concatenate(folder: folder, output: URL.anvilFile(outputPath))
    }
  }

  func deleteRecording(outputDirectory: String, recordingId: String) throws -> Promise<Bool> {
    return Promise.parallel(Self.queue) {
      let folder = URL.anvilDirectory(outputDirectory).appendingPathComponent(recordingId)
      guard FileManager.default.fileExists(atPath: folder.path) else { return false }
      try FileManager.default.removeItem(at: folder)
      return true
    }
  }

  func retryPendingUploads(outputDirectory: String) throws -> Promise<[PendingUpload]> {
    return Promise.parallel(Self.queue) {
      try UploadSentinelStore.listPending(outputDirectory: URL.anvilDirectory(outputDirectory))
    }
  }

  func markSegmentUploaded(outputDirectory: String, recordingId: String, filename: String) throws -> Promise<Void> {
    return Promise.parallel(Self.queue) {
      let folder = URL.anvilDirectory(outputDirectory).appendingPathComponent(recordingId)
      try UploadSentinelStore.mark(folder: folder, filename: filename)
    }
  }
}
