import CryptoKit
import Foundation

extension URL {
  /// Streams the file through SHA-256 and returns lowercase hex.
  func anvilSHA256Hex() throws -> String {
    let handle = try FileHandle(forReadingFrom: self)
    defer { try? handle.close() }
    var hasher = SHA256()
    while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }
}
