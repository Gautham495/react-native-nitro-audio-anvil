import Foundation

extension URL {
  /// Accepts both plain file paths and `file://` URLs.
  static func anvilFile(_ path: String) -> URL {
    if path.hasPrefix("file://"), let url = URL(string: path) {
      return url
    }
    return URL(fileURLWithPath: path, isDirectory: false)
  }
}
