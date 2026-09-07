import Foundation

extension Data {
  /// Interprets the bytes as little-endian Int16 PCM samples.
  var anvilInt16Samples: [Int16] {
    let count = self.count / 2
    var samples = [Int16](repeating: 0, count: count)
    self.withUnsafeBytes { raw in
      for index in 0..<count {
        let low = UInt16(raw[index * 2])
        let high = UInt16(raw[index * 2 + 1])
        samples[index] = Int16(bitPattern: low | (high << 8))
      }
    }
    return samples
  }
}
