import Foundation

extension Data {
  /// Reads a little-endian UInt32 at `offset` (relative to `startIndex`).
  func anvilUInt32(at offset: Int) -> UInt32 {
    let base = startIndex + offset
    return UInt32(self[base])
      | UInt32(self[base + 1]) << 8
      | UInt32(self[base + 2]) << 16
      | UInt32(self[base + 3]) << 24
  }
}
