import Foundation

/// A segment file (closed or still open) with its position on the recording timeline.
struct RangeSource {
  let url: URL
  let mediaStartMs: Double
  let dataBytes: Int
}
