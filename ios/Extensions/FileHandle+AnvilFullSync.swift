import Foundation

extension FileHandle {
  /// `F_FULLFSYNC` — flushes the writes to physical storage on iOS.
  /// Plain `fsync(2)` on iOS returns before the writes hit the flash; only
  /// `F_FULLFSYNC` provides the durability guarantee that our recovery story assumes.
  /// See <https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html>.
  func anvilFullSync() throws {
    let result = fcntl(fileDescriptor, F_FULLFSYNC)
    if result == -1 {
      let code = errno
      throw AnvilError(.io, "F_FULLFSYNC failed (errno \(code))")
    }
  }
}
