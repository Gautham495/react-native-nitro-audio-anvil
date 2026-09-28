import Foundation

extension URL {
  /// Opens the directory read-only, `F_FULLFSYNC`s it, closes it. Required after a
  /// rename to make the rename itself durable — otherwise a power loss between the
  /// rename and the next dir-fsync can leave the directory pointing at the old file.
  func anvilFullSyncDirectory() throws {
    let fd = open(path, O_RDONLY)
    if fd == -1 {
      let code = errno
      throw AnvilError(.io, "open(\(lastPathComponent)) for dir fsync failed (errno \(code))")
    }
    defer { close(fd) }
    if fcntl(fd, F_FULLFSYNC) == -1 {
      let code = errno
      throw AnvilError(.io, "F_FULLFSYNC on \(lastPathComponent) failed (errno \(code))")
    }
  }
}
