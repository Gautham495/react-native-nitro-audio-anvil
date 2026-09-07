import AVFoundation
import Foundation
import NitroModules

/// Autolinked root object. Creates recorders, answers permission questions, recovers orphaned sessions.
final class HybridAnvilFactory: HybridAnvilFactorySpec {
  private static let queue = DispatchQueue(label: "ai.nitroaudio.anvil.factory")

  func createRecorder(config: RecorderConfig) throws -> Promise<any HybridAnvilRecorderSpec> {
    return Promise.parallel(Self.queue) { () throws -> any HybridAnvilRecorderSpec in
      try RecorderConfigValidator.validate(config)
      return HybridAnvilRecorder(config: config)
    }
  }

  func getPermissionStatus() throws -> PermissionStatus {
    return AVAudioSession.sharedInstance().anvilPermissionStatus
  }

  func requestPermission() throws -> Promise<PermissionStatus> {
    return Promise.async { await AVAudioSession.anvilRequestPermission() }
  }

  func discoverOrphanedRecordings(directory: String) throws -> Promise<[OrphanedRecording]> {
    return Promise.parallel(Self.queue) {
      try OrphanScanner.discover(directory: URL.anvilDirectory(directory))
    }
  }
}
