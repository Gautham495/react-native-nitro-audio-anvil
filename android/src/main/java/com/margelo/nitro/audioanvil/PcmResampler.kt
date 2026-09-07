package com.margelo.nitro.audioanvil

import kotlin.math.floor
import kotlin.math.roundToInt

/**
 * Linear-interpolation resampler used only when the device cannot open AudioRecord at the
 * requested rate (44.1 kHz is the only rate Android guarantees). Speech quality is unaffected.
 */
internal class PcmResampler(inputRate: Int, outputRate: Int) {
  private val step = inputRate.toDouble() / outputRate.toDouble()
  private var position = 0.0
  private var previous: Short = 0

  fun resample(input: ShortArray, count: Int): ShortArray {
    if (count <= 0) return ShortArray(0)
    val output = ShortArray(((count + 1) / step).toInt() + 2)
    var produced = 0
    while (true) {
      val index = floor(position).toInt()
      if (index + 1 >= count) break
      val fraction = position - index
      val first = if (index < 0) previous.toDouble() else input[index].toDouble()
      val second = input[index + 1].toDouble()
      val value = first + (second - first) * fraction
      output[produced] = value.roundToInt().coerceIn(-32768, 32767).toShort()
      produced++
      position += step
    }
    previous = input[count - 1]
    position -= count
    return output.copyOf(produced)
  }
}
