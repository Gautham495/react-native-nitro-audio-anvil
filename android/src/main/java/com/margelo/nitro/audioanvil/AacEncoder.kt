package com.margelo.nitro.audioanvil

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import java.nio.ByteBuffer

/**
 * Encodes mono Int16 PCM at `sampleRate` to ADTS-wrapped AAC-LC frames at `bitrate`.
 * Owns one `MediaCodec` in synchronous mode. All calls must happen on the recorder's
 * owner thread — MediaCodec is not thread-safe.
 *
 * AAC-LC always produces 1024-sample frames — at 16 kHz that's 64 ms per frame. The
 * encoder accumulates PCM until it has at least one frame, feeds it to MediaCodec,
 * drains all pending output. Leftover PCM (< one frame) stays pending for the next
 * `encode()` call; `drain()` flushes with a silence-padded final frame on segment close.
 */
internal class AacEncoder(private val sampleRate: Int, bitrate: Int) {
  companion object {
    /** AAC-LC always produces 1024 samples per frame. */
    const val SAMPLES_PER_AAC_FRAME = 1024
    private const val MIME = MediaFormat.MIMETYPE_AUDIO_AAC
    private const val DEQUEUE_TIMEOUT_US = 10_000L
  }

  data class Frame(val bytes: ByteArray, val pcmSamples: Int)

  private val codec: MediaCodec
  private val pending = ArrayList<Short>(SAMPLES_PER_AAC_FRAME * 4)
  private var presentationTimeUs: Long = 0

  init {
    val format = MediaFormat.createAudioFormat(MIME, sampleRate, 1).apply {
      setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
      setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, SAMPLES_PER_AAC_FRAME * 2)
    }
    codec = try {
      MediaCodec.createEncoderByType(MIME)
    } catch (e: Exception) {
      throw AnvilException(RecorderErrorCode.ENGINE, "Cannot create AAC encoder: ${e.message}")
    }
    try {
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      codec.start()
    } catch (e: Exception) {
      codec.release()
      throw AnvilException(RecorderErrorCode.ENGINE, "Cannot configure AAC encoder: ${e.message}")
    }
  }

  /** Appends PCM samples and drains all AAC frames the encoder can produce. */
  fun encode(samples: ShortArray, count: Int): List<Frame> {
    for (i in 0 until count) pending.add(samples[i])
    return drainInternal(flush = false)
  }

  /**
   * Returns any complete AAC frames plus, if there's a partial-frame remainder, one
   * final frame padded with silence so no captured audio is lost at a segment boundary.
   */
  fun drain(): List<Frame> = drainInternal(flush = true)

  /** Releases the codec. Do not call any other method afterwards. */
  fun release() {
    try {
      codec.stop()
    } catch (_: Exception) {
    }
    codec.release()
  }

  private fun drainInternal(flush: Boolean): List<Frame> {
    val out = ArrayList<Frame>()
    while (pending.size >= SAMPLES_PER_AAC_FRAME) {
      val block = ShortArray(SAMPLES_PER_AAC_FRAME) { pending[it] }
      for (i in 0 until SAMPLES_PER_AAC_FRAME) pending.removeAt(0)
      feedAndDrain(block, isFinal = false, out)
    }
    if (flush && pending.isNotEmpty()) {
      val padded = ShortArray(SAMPLES_PER_AAC_FRAME)
      for (i in pending.indices) padded[i] = pending[i]
      pending.clear()
      feedAndDrain(padded, isFinal = true, out)
    }
    return out
  }

  private fun feedAndDrain(samples: ShortArray, isFinal: Boolean, out: ArrayList<Frame>) {
    val inputIndex = codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
    if (inputIndex >= 0) {
      val buffer = codec.getInputBuffer(inputIndex)
        ?: throw AnvilException(RecorderErrorCode.ENGINE, "AAC encoder returned null input buffer")
      buffer.clear()
      val bytes = samples.toLittleEndianBytes(samples.size)
      buffer.put(bytes)
      val flags = if (isFinal) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0
      codec.queueInputBuffer(inputIndex, 0, bytes.size, presentationTimeUs, flags)
      presentationTimeUs += samples.size * 1_000_000L / sampleRate
    }
    drainOutput(out)
  }

  private fun drainOutput(out: ArrayList<Frame>) {
    val info = MediaCodec.BufferInfo()
    while (true) {
      val index = codec.dequeueOutputBuffer(info, 0)
      if (index == MediaCodec.INFO_TRY_AGAIN_LATER) break
      if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue
      if (index < 0) continue

      val buffer = codec.getOutputBuffer(index)
      if (buffer == null) {
        codec.releaseOutputBuffer(index, false)
        continue
      }

      // Skip codec config packets (SPS/PPS-equivalent for AAC); ADTS carries the config
      // in its own header per-frame, so we don't need the codec-specific-data blob.
      val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
      val payloadSize = info.size
      if (isConfig || payloadSize <= 0) {
        codec.releaseOutputBuffer(index, false)
        continue
      }

      buffer.position(info.offset)
      buffer.limit(info.offset + payloadSize)
      val payload = ByteArray(payloadSize)
      buffer.get(payload)
      codec.releaseOutputBuffer(index, false)

      val header = AdtsHeader.bytes(sampleRate = sampleRate, channels = 1, aacFrameBytes = payloadSize)
      val framed = ByteArray(header.size + payload.size)
      System.arraycopy(header, 0, framed, 0, header.size)
      System.arraycopy(payload, 0, framed, header.size, payload.size)
      out.add(Frame(bytes = framed, pcmSamples = SAMPLES_PER_AAC_FRAME))

      if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break
    }
  }
}
