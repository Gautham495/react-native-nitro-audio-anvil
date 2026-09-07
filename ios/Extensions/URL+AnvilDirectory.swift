import Foundation

extension URL {
  /// Accepts both plain paths and `file://` URLs.
  static func anvilDirectory(_ path: String) -> URL {
    if path.hasPrefix("file://"), let url = URL(string: path) {
      return url
    }
    return URL(fileURLWithPath: path, isDirectory: true)
  }
}
