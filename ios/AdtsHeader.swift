import Foundation

/// Builds a 7-byte ADTS header for one raw AAC-LC frame produced by `AVAudioConverter`.
///
/// Apple's converter emits bare AAC frames without a container. HLS players expect ADTS,
/// so we wrap each frame ourselves. Layout (no CRC, so header length = 7):
///
/// ```
/// AAAAAAAA AAAABCCD EEFFFFGH HHIJKLMM MMMMMMMM MMMOOOOO OOOOOOPP
/// A: syncword 0xFFF        (12 bits)
/// B: MPEG version = 0 (MPEG-4)
/// C: layer = 0
/// D: protection absent = 1 (no CRC)
/// E: profile = 1 (AAC-LC)  → in header we write profile-1
/// F: sampling frequency index (4 bits)
/// G: private = 0
/// H: channel configuration (3 bits) — 1 for mono
/// I: originality = 0
/// J: home = 0
/// K: copyright id bit = 0
/// L: copyright id start = 0
/// M: frame length INCLUDING header (13 bits)
/// O: buffer fullness = 0x7FF (VBR sentinel)
/// P: number of raw data blocks in frame minus one = 0
/// ```
enum AdtsHeader {
  static let byteCount = 7

  private static let samplingFrequencyIndexMap: [Int: UInt8] = [
    96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
    24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11,
  ]

  /// Returns the ADTS index for a sample rate, or `nil` for an unsupported rate.
  static func samplingFrequencyIndex(for sampleRate: Int) -> UInt8? {
    return samplingFrequencyIndexMap[sampleRate]
  }

  /// Builds an ADTS header for a single AAC-LC frame. `aacFrameBytes` is the payload size
  /// WITHOUT the header — the total frame length in the header includes header+payload.
  static func bytes(sampleRate: Int, channels: Int, aacFrameBytes: Int) throws -> Data {
    guard let sfi = samplingFrequencyIndex(for: sampleRate) else {
      throw AnvilError(.engine, "Unsupported ADTS sample rate \(sampleRate)")
    }
    guard channels >= 1, channels <= 7 else {
      throw AnvilError(.engine, "Unsupported ADTS channel count \(channels)")
    }
    let profileMinusOne: UInt8 = 1 // AAC-LC = 2, stored as 2-1=1
    let channelConfig = UInt8(channels)
    let totalLength = UInt32(byteCount + aacFrameBytes)
    guard totalLength <= 0x1FFF else {
      throw AnvilError(.engine, "AAC frame too large for ADTS (\(aacFrameBytes) bytes)")
    }

    var header = Data(count: byteCount)
    header[0] = 0xFF
    // 0xF0: sync, MPEG-4, layer=0, protection absent = 1
    header[1] = 0xF1
    header[2] = (profileMinusOne << 6)
      | ((sfi & 0x0F) << 2)
      | ((channelConfig & 0x04) >> 2)
    header[3] = ((channelConfig & 0x03) << 6)
      | UInt8((totalLength >> 11) & 0x03)
    header[4] = UInt8((totalLength >> 3) & 0xFF)
    header[5] = UInt8((totalLength & 0x07) << 5) | 0x1F
    header[6] = 0xFC
    return header
  }
}
