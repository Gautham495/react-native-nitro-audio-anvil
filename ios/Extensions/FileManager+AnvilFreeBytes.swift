import Foundation

extension FileManager {
  /// Free space on the volume containing `url`, in bytes. Falls back to `Int64.max` when unknown.
  func anvilFreeBytes(at url: URL) -> Int64 {
    if let capacity = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage {
      return capacity
    }
    let attributes = try? attributesOfFileSystem(forPath: url.path)
    return (attributes?[.systemFreeSize] as? NSNumber)?.int64Value ?? Int64.max
  }
}
