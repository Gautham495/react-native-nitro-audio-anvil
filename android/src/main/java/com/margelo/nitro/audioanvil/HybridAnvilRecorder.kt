package com.margelo.nitro.audioanvil

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.ReactApplicationContext
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import java.io.File
import java.io.IOException

/**
 * One recording session. All mutable state lives on the "anvil-audio" HandlerThread;
 * JS-facing methods hop onto it through `Handler.promise`, native callbacks are delivered on it.
 */
@Keep
@DoNotStrip
class HybridAnvilRecorder(private val config: RecorderConfig) : HybridAnvilRecorderSpec() {
  private val context: ReactApplicationContext
    get() = NitroModules.applicationContext ?: throw AnvilException(RecorderErrorCode.STATE, "No ApplicationContext set!")

  private val thread = HandlerThread("anvil-audio", Process.THREAD_PRIORITY_URGENT_AUDIO).apply { start() }
  private val handler = Handler(thread.looper)
  private val directory = AnvilPaths.directory(config.outputDirectory)
  private val sampleRateHz = config.sampleRate.toInt()

  private var focus: AnvilAudioFocus? = null
  private var capture: AnvilCaptureLoop? = null
  private var writer: WavSegmentWriter? = null
  private val segments = ArrayList<RecordingSegment>()
  private var nextSegmentIndex = 0
  private var totalSamples = 0L
  private var lastPermission = PermissionStatus.UNDETERMINED
  private var lastInterruptionReason = InterruptionReason.OTHER
  private var serviceRunning = false

  private val pcmListeners = ListenerRegistry<PCMChunk>()
  private val speakerListeners = ListenerRegistry<SpeakerWindow>()
  private val interruptionListeners = ListenerRegistry<InterruptionEvent>()
  private val routeListeners = ListenerRegistry<RouteChangeEvent>()
  private val permissionListeners = ListenerRegistry<PermissionStatus>()
  private val storageListeners = ListenerRegistry<StorageWarningEvent>()
  private val segmentListeners = ListenerRegistry<RecordingSegment>()
  private val errorListeners = ListenerRegistry<RecorderError>()

  private val chunker = PcmChunker(sampleRateHz, config.streamChunkMs) { chunk -> pcmListeners.emit(chunk) }
  private val speakerWindows = SpeakerWindowAssembler(sampleRateHz, config.speakerWindowMs, config.speakerWindowHopMs) { window ->
    speakerListeners.emit(window)
  }

  // Snapshots readable from the JS thread.
  @Volatile private var stateValue = RecorderState.IDLE
  @Volatile private var totalDurationValue = 0.0
  @Volatile private var currentSegmentPathValue = ""

  override val sessionId: String = "anvil-${System.currentTimeMillis()}"

  override val state: RecorderState
    get() = stateValue

  override val totalDurationMs: Double
    get() = totalDurationValue

  override val currentSegmentPath: String
    get() = currentSegmentPathValue

  // ---- Spec methods ----------------------------------------------------------------------------

  override fun start(): Promise<Unit> = handler.promise { performStart() }

  override fun pause(): Promise<Unit> = handler.promise { performPause() }

  override fun resume(): Promise<Unit> = handler.promise { performResume() }

  override fun stop(): Promise<Array<RecordingSegment>> = handler.promise { performStop() }

  override fun rotateSegment(): Promise<RecordingSegment> = handler.promise { performRotate(routeChanged = false) }

  override fun extractRange(startMs: Double, endMs: Double): Promise<String> {
    if (thread.isAlive) {
      return handler.promise { performExtract(startMs, endMs) }
    }
    return Promise.parallel { performExtract(startMs, endMs) }
  }

  override fun addPCMListener(listener: (PCMChunk) -> Unit): ListenerSubscription = subscribe(pcmListeners, listener)

  override fun addSpeakerWindowListener(listener: (SpeakerWindow) -> Unit): ListenerSubscription = subscribe(speakerListeners, listener)

  override fun addInterruptionListener(listener: (InterruptionEvent) -> Unit): ListenerSubscription = subscribe(interruptionListeners, listener)

  override fun addRouteChangeListener(listener: (RouteChangeEvent) -> Unit): ListenerSubscription = subscribe(routeListeners, listener)

  override fun addPermissionChangeListener(listener: (PermissionStatus) -> Unit): ListenerSubscription = subscribe(permissionListeners, listener)

  override fun addStorageWarningListener(listener: (StorageWarningEvent) -> Unit): ListenerSubscription = subscribe(storageListeners, listener)

  override fun addSegmentCompletedListener(listener: (RecordingSegment) -> Unit): ListenerSubscription = subscribe(segmentListeners, listener)

  override fun addErrorListener(listener: (RecorderError) -> Unit): ListenerSubscription = subscribe(errorListeners, listener)

  private fun <Event> subscribe(registry: ListenerRegistry<Event>, listener: (Event) -> Unit): ListenerSubscription {
    val id = registry.add(listener)
    return ListenerSubscription(remove = { registry.remove(id) })
  }

  // ---- Lifecycle (owner thread) ----------------------------------------------------------------

  private fun performStart() {
    if (stateValue != RecorderState.IDLE) {
      throw AnvilException(RecorderErrorCode.STATE, "start() is only valid in idle state (now $stateValue)")
    }
    checkPermission()
    if (!directory.isDirectory && !directory.mkdirs()) {
      throw AnvilException(RecorderErrorCode.IO, "Cannot create ${directory.absolutePath}")
    }
    OrphanScanner.markerFile(directory, sessionId).writeBytes(ByteArray(0))
    startService()
    checkStorage()
    openSegment()
    startCapture()
    stateValue = RecorderState.RECORDING
  }

  private fun performPause() {
    if (stateValue != RecorderState.RECORDING) {
      throw AnvilException(RecorderErrorCode.STATE, "pause() is only valid while recording (now $stateValue)")
    }
    stopCapture()
    closeSegment(flushStreams = true)
    stateValue = RecorderState.PAUSED
  }

  private fun performResume() {
    if (stateValue != RecorderState.PAUSED && stateValue != RecorderState.INTERRUPTED) {
      throw AnvilException(RecorderErrorCode.STATE, "resume() is only valid from paused or interrupted (now $stateValue)")
    }
    checkPermission()
    openSegment()
    startCapture()
    stateValue = RecorderState.RECORDING
  }

  private fun performStop(): Array<RecordingSegment> {
    if (stateValue == RecorderState.STOPPED) return segments.toTypedArray()
    stopCapture()
    focus?.release()
    focus = null
    if (writer != null) {
      closeSegment(flushStreams = true)
    }
    stopService()
    OrphanScanner.markerFile(directory, sessionId).delete()
    stateValue = RecorderState.STOPPED
    thread.quitSafely()
    return segments.toTypedArray()
  }

  private fun performRotate(routeChanged: Boolean): RecordingSegment {
    val current = writer
    if (stateValue != RecorderState.RECORDING || current == null) {
      throw AnvilException(RecorderErrorCode.STATE, "rotateSegment() is only valid while recording")
    }
    current.routeChanged = routeChanged
    val finished = closeSegment(flushStreams = routeChanged)
    openSegment()
    checkStorage()
    return finished
  }

  private fun performExtract(startMs: Double, endMs: Double): String {
    val sources = ArrayList<RangeSource>()
    for (segment in segments) {
      sources.add(RangeSource(File(segment.filePath), segment.mediaStartMs, segment.fileSize.toInt() - WavHeader.BYTE_COUNT))
    }
    writer?.let {
      it.flush()
      sources.add(RangeSource(it.file, it.mediaStartMs, it.dataBytes))
    }
    val target = File(directory, "${sessionId}_extract_${startMs.toLong()}_${endMs.toLong()}.wav")
    RangeExtractor.extract(sources, sampleRateHz, startMs, endMs, target)
    return target.absolutePath
  }

  // ---- Segments (owner thread) -----------------------------------------------------------------

  private fun openSegment() {
    val file = File(directory, "$sessionId-" + "%05d".format(nextSegmentIndex) + ".wav")
    val mediaStartMs = totalSamples / sampleRateHz.toDouble() * 1000.0
    writer = WavSegmentWriter(file, nextSegmentIndex, sampleRateHz, mediaStartMs, config.fsyncIntervalMs)
    nextSegmentIndex++
    currentSegmentPathValue = file.absolutePath
  }

  private fun closeSegment(flushStreams: Boolean): RecordingSegment {
    val current = writer ?: throw AnvilException(RecorderErrorCode.STATE, "No open segment")
    if (flushStreams) {
      chunker.flush()
      speakerWindows.reset()
    }
    writer = null
    currentSegmentPathValue = ""
    val finished = try {
      current.complete()
    } catch (e: IOException) {
      current.abandon()
      throw AnvilException(RecorderErrorCode.IO, "Finalizing ${current.file.name} failed: ${e.message}")
    }
    segments.add(finished)
    segmentListeners.emit(finished)
    return finished
  }

  // ---- Capture (owner thread) ------------------------------------------------------------------

  private fun startCapture() {
    val loop = capture ?: AnvilCaptureLoop(
      handler,
      sampleRateHz,
      config.streamChunkMs.toInt().coerceIn(20, 200),
      ::handlePcm,
      ::handleCaptureError,
    ).also { capture = it }
    loop.start()
    val audioFocus = focus ?: AnvilAudioFocus(context, handler).also {
      it.onInterruptionBegan = ::handleInterruptionBegan
      it.onInterruptionEnded = ::handleInterruptionEnded
      it.onRouteChanged = ::handleRouteChanged
      focus = it
    }
    audioFocus.acquire(loop.audioSessionId)
  }

  private fun stopCapture() {
    capture?.stop()
  }

  private fun handlePcm(samples: ShortArray, count: Int) {
    if (stateValue != RecorderState.RECORDING) return
    val current = writer ?: return
    val startSamples = totalSamples
    val bytes = samples.toLittleEndianBytes(count)
    try {
      current.append(bytes, bytes.size)
    } catch (e: IOException) {
      val code = if (directory.usableSpace < 1_048_576L) RecorderErrorCode.STORAGE else RecorderErrorCode.IO
      fail(code, "Writing ${current.file.name} failed: ${e.message}")
      return
    }
    totalSamples += count
    totalDurationValue = totalSamples / sampleRateHz.toDouble() * 1000.0
    chunker.append(bytes, bytes.size, startSamples)
    speakerWindows.append(samples, count, startSamples)
    if (current.durationMs >= config.segmentDurationMs) {
      try {
        closeSegment(flushStreams = false)
        openSegment()
        checkStorage()
      } catch (e: Exception) {
        fail(RecorderErrorCode.IO, "Segment rotation failed: ${e.message}")
      }
    }
  }

  private fun handleCaptureError(error: AnvilException) {
    fail(error.code, error.message ?: "Capture failed")
  }

  // ---- Focus events (owner thread) -------------------------------------------------------------

  private fun handleInterruptionBegan(reason: InterruptionReason) {
    if (stateValue != RecorderState.RECORDING) return
    stopCapture()
    writer?.wasInterrupted = true
    writer?.interruptionReason = reason
    lastInterruptionReason = reason
    var path = ""
    try {
      path = closeSegment(flushStreams = true).filePath
    } catch (e: AnvilException) {
      emitError(RecorderErrorCode.IO, "Finalizing on interruption failed: ${e.message}")
    }
    stateValue = RecorderState.INTERRUPTED
    interruptionListeners.emit(
      InterruptionEvent(
        phase = InterruptionPhase.BEGAN,
        reason = reason,
        shouldResume = false,
        segmentPath = path,
        timestampMs = totalDurationValue,
      )
    )
  }

  private fun handleInterruptionEnded(shouldResume: Boolean) {
    if (stateValue != RecorderState.INTERRUPTED) return
    interruptionListeners.emit(
      InterruptionEvent(
        phase = InterruptionPhase.ENDED,
        reason = lastInterruptionReason,
        shouldResume = shouldResume,
        segmentPath = "",
        timestampMs = totalDurationValue,
      )
    )
    if (config.onInterruption != InterruptionPolicy.RESUME || !shouldResume) return
    try {
      performResume()
    } catch (e: Exception) {
      emitError(RecorderErrorCode.ENGINE, "Auto-resume after interruption failed: ${e.message}")
    }
  }

  private fun handleRouteChanged(reason: RouteChangeReason, inputName: String) {
    val recording = stateValue == RecorderState.RECORDING
    routeListeners.emit(RouteChangeEvent(reason = reason, inputName = inputName, inputChanged = recording, timestampMs = totalDurationValue))
    if (!recording) return
    try {
      performRotate(routeChanged = true)
    } catch (e: Exception) {
      fail(RecorderErrorCode.IO, "Segment rotation after route change failed: ${e.message}")
    }
  }

  // ---- Service, checks and failure (owner thread) ----------------------------------------------

  private fun startService() {
    if (!config.keepAwakeInBackground || serviceRunning) return
    val notification = config.notification ?: throw AnvilException(RecorderErrorCode.STATE, "notification is required when keepAwakeInBackground is true")
    AnvilRecordingService.start(context, notification.title, notification.text)
    serviceRunning = true
  }

  private fun stopService() {
    if (!serviceRunning) return
    AnvilRecordingService.stop(context)
    serviceRunning = false
  }

  private fun checkPermission() {
    val status = AnvilPermission.status(context, context.currentActivity)
    if (status != lastPermission) {
      lastPermission = status
      permissionListeners.emit(status)
    }
    if (status != PermissionStatus.GRANTED) {
      throw AnvilException(RecorderErrorCode.PERMISSION, "Microphone permission is $status")
    }
  }

  private fun checkStorage() {
    val free = directory.usableSpace.toDouble()
    if (free < config.storageWarningBytes) {
      storageListeners.emit(StorageWarningEvent(freeBytes = free, thresholdBytes = config.storageWarningBytes))
    }
  }

  /** Stops capture, secures whatever is on disk, moves to `interrupted` and reports the error. */
  private fun fail(code: RecorderErrorCode, message: String) {
    stopCapture()
    val current = writer
    if (current != null) {
      writer = null
      currentSegmentPathValue = ""
      chunker.flush()
      speakerWindows.reset()
      try {
        val finished = current.complete()
        segments.add(finished)
        segmentListeners.emit(finished)
      } catch (_: IOException) {
        current.abandon()
      }
    }
    if (stateValue == RecorderState.RECORDING) {
      stateValue = RecorderState.INTERRUPTED
    }
    emitError(code, message)
  }

  private fun emitError(code: RecorderErrorCode, message: String) {
    errorListeners.emit(RecorderError(code = code, message = message, timestampMs = totalDurationValue))
  }
}
