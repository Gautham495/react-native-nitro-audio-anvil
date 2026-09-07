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

/**
 * Holds audio focus while recording and turns "our capture got silenced" (call, other app)
 * and input device changes into callbacks on the recorder's thread.
 */
internal class AnvilAudioFocus(context: Context, private val handler: Handler) {
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var focusRequest: AudioFocusRequest? = null
  private var audioSessionId = 0
  private var interrupted = false
  private var deviceCallbackPrimed = false

  var onInterruptionBegan: ((InterruptionReason) -> Unit)? = null
  var onInterruptionEnded: ((Boolean) -> Unit)? = null
  var onRouteChanged: ((RouteChangeReason, String) -> Unit)? = null

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    // On Q+ the recording callback is the accurate signal; focus is only kept so other audio pauses.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return@OnAudioFocusChangeListener
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> began(currentReason())
      AudioManager.AUDIOFOCUS_GAIN -> ended()
    }
  }

  private val recordingCallback = object : AudioManager.AudioRecordingCallback() {
    override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
      val mine = configs.firstOrNull { it.clientAudioSessionId == audioSessionId } ?: return
      if (mine.isClientSilenced) began(currentReason()) else ended()
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
      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(attributes)
        .setOnAudioFocusChangeListener(focusListener, handler)
        .build()
      audioManager.requestAudioFocus(request)
      focusRequest = request
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
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

  private fun currentReason(): InterruptionReason {
    return when (audioManager.mode) {
      AudioManager.MODE_IN_CALL, AudioManager.MODE_IN_COMMUNICATION, AudioManager.MODE_RINGTONE -> InterruptionReason.CALL
      else -> InterruptionReason.FOCUS
    }
  }

  private fun began(reason: InterruptionReason) {
    if (interrupted) return
    interrupted = true
    onInterruptionBegan?.invoke(reason)
  }

  private fun ended() {
    if (!interrupted) return
    interrupted = false
    onInterruptionEnded?.invoke(true)
  }
}
