package com.margelo.nitro.audioanvil

/**
 * Builds a 7-byte ADTS header for one raw AAC-LC frame produced by MediaCodec.
 * MediaCodec emits bare AAC access units without ADTS framing when the output format
 * is `audio/mp4a-latm`; we prepend the header ourselves so HLS players can decode
 * each segment.
 *
 * Layout (no CRC, so header length = 7):
 *
 * ```
 * AAAAAAAA AAAABCCD EEFFFFGH HHIJKLMM MMMMMMMM MMMOOOOO OOOOOOPP
 * A: syncword 0xFFF        (12 bits)
 * B: MPEG version = 0 (MPEG-4)
 * C: layer = 0
 * D: protection absent = 1 (no CRC)
 * E: profile-1 (AAC-LC = 2, stored as 1 = profile-1 pattern)
 * F: sampling frequency index (4 bits)
 * G: private = 0
 * H: channel configuration (3 bits) — 1 for mono
 * I: originality = 0
 * J: home = 0
 * K: copyright id bit = 0
 * L: copyright id start = 0
 * M: frame length INCLUDING header (13 bits)
 * O: buffer fullness = 0x7FF (VBR sentinel)
 * P: number of raw data blocks in frame minus one = 0
 * ```
 */
internal object AdtsHeader {
  const val BYTE_COUNT = 7

  private val samplingFrequencyIndexMap = mapOf(
    96000 to 0, 88200 to 1, 64000 to 2, 48000 to 3, 44100 to 4, 32000 to 5,
    24000 to 6, 22050 to 7, 16000 to 8, 12000 to 9, 11025 to 10, 8000 to 11,
  )

  fun samplingFrequencyIndex(sampleRate: Int): Int? = samplingFrequencyIndexMap[sampleRate]

  /** Builds a header for a single AAC-LC frame. `aacFrameBytes` excludes the header. */
  fun bytes(sampleRate: Int, channels: Int, aacFrameBytes: Int): ByteArray {
    val sfi = samplingFrequencyIndex(sampleRate)
      ?: throw AnvilException(RecorderErrorCode.ENGINE, "Unsupported ADTS sample rate $sampleRate")
    if (channels !in 1..7) {
      throw AnvilException(RecorderErrorCode.ENGINE, "Unsupported ADTS channel count $channels")
    }
    val profileMinusOne = 1 // AAC-LC = 2 → stored as 1
    val channelConfig = channels
    val totalLength = BYTE_COUNT + aacFrameBytes
    if (totalLength > 0x1FFF) {
      throw AnvilException(RecorderErrorCode.ENGINE, "AAC frame too large for ADTS ($aacFrameBytes bytes)")
    }
    val header = ByteArray(BYTE_COUNT)
    header[0] = 0xFF.toByte()
    header[1] = 0xF1.toByte() // sync + MPEG-4 + layer=0 + protection absent = 1
    header[2] = (
      (profileMinusOne shl 6) or
        ((sfi and 0x0F) shl 2) or
        ((channelConfig and 0x04) shr 2)
      ).toByte()
    header[3] = (
      ((channelConfig and 0x03) shl 6) or
        ((totalLength shr 11) and 0x03)
      ).toByte()
    header[4] = ((totalLength shr 3) and 0xFF).toByte()
    header[5] = (((totalLength and 0x07) shl 5) or 0x1F).toByte()
    header[6] = 0xFC.toByte()
    return header
  }
}
