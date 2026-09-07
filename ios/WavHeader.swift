import Foundation

/// Builds and reads the 44-byte canonical PCM WAV header (mono, 16-bit).
enum WavHeader {
  static let byteCount = 44
  static let riffSizeOffset: UInt64 = 4
  static let dataSizeOffset: UInt64 = 40
  static let channels: UInt16 = 1
  static let bitsPerSample: UInt16 = 16

  static func bytes(sampleRate: Int, dataBytes: Int) -> Data {
    let bytesPerFrame = channels * (bitsPerSample / 8)
    let byteRate = UInt32(sampleRate) * UInt32(bytesPerFrame)
    var data = Data(capacity: byteCount)
    data.append(contentsOf: Array("RIFF".utf8))
    data.append(UInt32(36 + dataBytes).anvilLittleEndianData)
    data.append(contentsOf: Array("WAVE".utf8))
    data.append(contentsOf: Array("fmt ".utf8))
    data.append(UInt32(16).anvilLittleEndianData)
    data.append(UInt16(1).anvilLittleEndianData)
    data.append(channels.anvilLittleEndianData)
    data.append(UInt32(sampleRate).anvilLittleEndianData)
    data.append(byteRate.anvilLittleEndianData)
    data.append(bytesPerFrame.anvilLittleEndianData)
    data.append(bitsPerSample.anvilLittleEndianData)
    data.append(contentsOf: Array("data".utf8))
    data.append(UInt32(dataBytes).anvilLittleEndianData)
    return data
  }

  /// Reads sample rate and declared data size. `nil` when the file is not a RIFF/WAVE file.
  static func read(from url: URL) throws -> (sampleRate: Int, dataBytes: Int)? {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    guard let data = try handle.read(upToCount: byteCount), data.count == byteCount else { return nil }
    guard data.subdata(in: 0..<4) == Data("RIFF".utf8), data.subdata(in: 8..<12) == Data("WAVE".utf8) else { return nil }
    return (Int(data.anvilUInt32(at: 24)), Int(data.anvilUInt32(at: 40)))
  }

  /// Rewrites the two size fields so the header matches `dataBytes` of audio.
  static func patch(handle: FileHandle, dataBytes: Int) throws {
    try handle.seek(toOffset: riffSizeOffset)
    try handle.write(contentsOf: UInt32(36 + dataBytes).anvilLittleEndianData)
    try handle.seek(toOffset: dataSizeOffset)
    try handle.write(contentsOf: UInt32(dataBytes).anvilLittleEndianData)
  }
}
