package com.margelo.nitro.audioanvil

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.os.Build
import android.os.Handler
import android.util.Log

/**
 * Holds audio focus while recording and turns "our capture got silenced" (call, other app)
 * and input device changes into callbacks on the recorder's thread.
 *
 * Signal sources per API level:
 *   • Q+ (10+): onRecordingConfigChanged.isClientSilenced tells us when we got silenced
 *     by another app taking the mic. This is the accurate BEGAN signal.
 *   • Pre-Q: focus LOSS/LOSS_TRANSIENT is the only BEGAN signal.
 *
 *   • For ENDED: focus GAIN is the only reliable signal on ALL API levels.
 *     onRecordingConfigChanged does NOT fire with isClientSilenced=false when the
 *     other app releases the mic, because after our capture loop stops there's no
 *     active recording config to un-silence. Previously we early-returned from
 *     the focus listener on Q+, which meant we never got an ENDED event and
 *     auto-resume never ran. Now we use focus GAIN on all API levels for ENDED.
 */
internal class AnvilAudioFocus(context: Context, private val handler: Handler) {
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var focusRequest: AudioFocusRequest? = null
  private var audioSessionId = 0
  private var interrupted = false
  private var deviceCallbackPrimed = false

  var onInterruptionBegan: ((AnvilInterruptionReason) -> Unit)? = null
  var onInterruptionEnded: ((Boolean) -> Unit)? = null
  var onRouteChanged: ((RouteChangeReason, String) -> Unit)? = null

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    Log.i("AnvilAudioFocus", "focus change: $change (interrupted=$interrupted)")
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
        // On Q+ the recording callback is the accurate BEGAN signal because it
        // catches cases where we're silenced without a formal focus loss.
        // Below Q, focus loss is our only BEGAN signal.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
          began(currentReason())
        }
        // On Q+ we still return here — don't double-fire began.
      }
      AudioManager.AUDIOFOCUS_GAIN -> {
        // Focus GAIN is the reliable ENDED signal on ALL API levels. The
        // recording callback doesn't fire with isClientSilenced=false because
        // the capture loop is already stopped.
        ended()
      }
    }
  }

  private val recordingCallback = object : AudioManager.AudioRecordingCallback() {
    override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
      val mine = configs.firstOrNull { it.clientAudioSessionId == audioSessionId }
      // If our config disappeared entirely, we've been fully preempted — treat
      // as an interruption began. Won't fire ended from here (see class doc).
      if (mine == null) return
      if (mine.isClientSilenced) {
        began(currentReason())
      }
      // NOTE: we intentionally do NOT call ended() on isClientSilenced=false
      // here. In practice this callback doesn't fire with isClientSilenced=false
      // because after capture stops the config either goes away or stays
      // silenced from Android's POV. Focus GAIN is the reliable ENDED signal.
    }
  }

  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) {
      // The first callback after registration lists the devices already connected — not a change.
      if (!deviceCallbackPrimed) {
        deviceCallbackPrimed = true
        return
      }
      val input = added.firstOrNull { it.isSource } ?: return
      onRouteChanged?.invoke(RouteChangeReason.CONNECTED, input.productName.toString())
    }

    override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) {
      val input = removed.firstOrNull { it.isSource } ?: return
      onRouteChanged?.invoke(RouteChangeReason.DISCONNECTED, input.productName.toString())
    }
  }

  fun acquire(sessionId: Int) {
    audioSessionId = sessionId
    interrupted = false
    deviceCallbackPrimed = false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      // Use USAGE_VOICE_COMMUNICATION + AUDIOFOCUS_GAIN_TRANSIENT. Two changes
      // from the previous version:
      //   1. USAGE_MEDIA → USAGE_VOICE_COMMUNICATION so the OS knows we're a
      //      microphone client, not media playback. Improves cooperation with
      //      calls and voice assistants.
      //   2. AUDIOFOCUS_GAIN → AUDIOFOCUS_GAIN_TRANSIENT. TRANSIENT means "I
      //      want focus but I know I might have to yield it and come back."
      //      Without TRANSIENT, WhatsApp's own AUDIOFOCUS_GAIN request
      //      permanently supplants us and we never get a GAIN callback when
      //      it's done.
      //   3. setAcceptsDelayedFocusGain(true) — critical. Tells the OS "if
      //      focus isn't available right now (another app has it), grant it
      //      to me when possible." Without this, in-progress calls block us
      //      from acquiring focus at all.
      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(attributes)
        .setAcceptsDelayedFocusGain(true)
        .setOnAudioFocusChangeListener(focusListener, handler)
        .build()
      val result = audioManager.requestAudioFocus(request)
      Log.i("AnvilAudioFocus", "requestAudioFocus result=$result")
      focusRequest = request
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(
        focusListener,
        AudioManager.STREAM_VOICE_CALL,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
      )
    }
    audioManager.registerAudioRecordingCallback(recordingCallback, handler)
    audioManager.registerAudioDeviceCallback(deviceCallback, handler)
  }

  fun release() {
    audioManager.unregisterAudioRecordingCallback(recordingCallback)
    audioManager.unregisterAudioDeviceCallback(deviceCallback)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
      focusRequest = null
    } else {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(focusListener)
    }
    interrupted = false
  }

  private fun currentReason(): AnvilInterruptionReason {
    return when (audioManager.mode) {
      AudioManager.MODE_IN_CALL, AudioManager.MODE_IN_COMMUNICATION, AudioManager.MODE_RINGTONE -> AnvilInterruptionReason.CALL
      else -> AnvilInterruptionReason.FOCUS
    }
  }

  private fun began(reason: AnvilInterruptionReason) {
    if (interrupted) return
    interrupted = true
    Log.i("AnvilAudioFocus", "began: $reason")
    onInterruptionBegan?.invoke(reason)
  }

  private fun ended() {
    if (!interrupted) return
    interrupted = false
    Log.i("AnvilAudioFocus", "ended: shouldResume=true")
    onInterruptionEnded?.invoke(true)
  }
}