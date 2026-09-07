package com.margelo.nitro.audioanvil

/** Serializes the first `count` samples as little-endian 16-bit PCM. */
internal fun ShortArray.toLittleEndianBytes(count: Int): ByteArray {
  val bytes = ByteArray(count * 2)
  for (i in 0 until count) {
    val sample = this[i].toInt()
    bytes[i * 2] = (sample and 0xFF).toByte()
    bytes[i * 2 + 1] = ((sample shr 8) and 0xFF).toByte()
  }
  return bytes
}
