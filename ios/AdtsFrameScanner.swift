import Foundation

/// Reads an ADTS AAC file's frame headers to measure its duration and detect corruption.
/// Used by the folder scanner to salvage unreferenced tail segments left behind by a
/// crash.
enum AdtsFrameScanner {
  struct Scan {
    /// Sample rate parsed from the first frame's ADTS header.
    let sampleRate: Int
    /// Total decoded audio duration in milliseconds (1024 samples per frame).
    let durationMs: Double
    /// Byte offset at which frames stopped parsing cleanly. On a torn tail this is short
    /// of the file size — everything up to it is playable, everything after is garbage.
    let validByteCount: Int
  }

  /// Frame length is encoded in header bits 30-42 (13 bits total).
  private static func frameLength(from header: Data, offset: Int) -> Int {
    let b3 = Int(header[offset + 3])
    let b4 = Int(header[offset + 4])
    let b5 = Int(header[offset + 5])
    return ((b3 & 0x03) << 11) | (b4 << 3) | ((b5 & 0xE0) >> 5)
  }

  private static let samplingFrequencyTable: [Int: Int] = [
    0: 96000, 1: 88200, 2: 64000, 3: 48000, 4: 44100, 5: 32000,
    6: 24000, 7: 22050, 8: 16000, 9: 12000, 10: 11025, 11: 8000,
  ]

  static func scan(url: URL) throws -> Scan? {
    let data = try Data(contentsOf: url, options: [.mappedIfSafe])
    guard data.count >= 7 else { return nil }

    var offset = 0
    var sampleRate = 0
    var frameCount = 0

    while offset + 7 <= data.count {
      let b0 = data[offset]
      let b1 = data[offset + 1]
      // Sync = 12 bits of 1s
      guard b0 == 0xFF, (b1 & 0xF0) == 0xF0 else { break }

      let length = frameLength(from: data, offset: offset)
      guard length >= 7, offset + length <= data.count else { break }

      if sampleRate == 0 {
        let b2 = data[offset + 2]
        let sfi = Int((b2 & 0x3C) >> 2)
        guard let rate = samplingFrequencyTable[sfi] else { return nil }
        sampleRate = rate
      }
      frameCount += 1
      offset += length
    }

    guard frameCount > 0, sampleRate > 0 else { return nil }
    let durationMs = Double(frameCount * 1024) / Double(sampleRate) * 1000.0
    return Scan(sampleRate: sampleRate, durationMs: durationMs, validByteCount: offset)
  }
}
