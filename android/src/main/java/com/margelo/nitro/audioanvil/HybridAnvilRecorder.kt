package com.margelo.nitro.audioanvil

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.StatFs
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.ReactApplicationContext
import com.margelo.nitro.core.Promise
import java.io.File

/**
 * One recording. All mutable state lives on the recorder's `HandlerThread`; JS-facing
 * methods hop onto it through `Handler.promise`, native callbacks are already delivered
 * on it (both `AnvilAudioFocus` and `AnvilCaptureLoop` are constructed with the same
 * Handler).
 *
 * The recorder owns `${outputDirectory}/${recordingId}/` and everything inside it. Live
 * streams (PCM chunks, speaker windows) fan out first, synchronously; the AAC encode +
 * segment write + manifest update run afterwards on the same thread. A disk stall
 * never blocks the STT / embedder path.
 */
@Keep
@DoNotStrip
class HybridAnvilRecorder(
  private val context: ReactApplicationContext,
  private val config: RecorderConfig,
  seededSegments: List<RecordingSegment>,
  seededNextIndex: Int,
  seededMediaMs: Double,
  resumingFromExisting: Boolean,
) : HybridAnvilRecorderSpec() {

  private val thread: HandlerThread = HandlerThread("anvil-recorder", Process.THREAD_PRIORITY_AUDIO).also { it.start() }
  private val handler: Handler = Handler(thread.looper)

  private val outputDirectory: File = AnvilPaths.directory(config.outputDirectory)
  private val folder: File = File(outputDirectory, config.recordingId)
  private val sampleRateInt: Int = config.sampleRate.toInt()
  private val focus = AnvilAudioFocus(context, handler)
  private val capture = AnvilCaptureLoop(
    handler = handler,
    targetSampleRate = sampleRateInt,
    readMs = maxOf(20, minOf(50, config.streamChunkMs.toInt())),
    onPcm = { samples, count -> handlePcm(samples, count) },
    onError = { error -> fail(error.code, error.message ?: "capture error") },
  )
  private val manifestWriter = HlsManifestWriter(
    folder = folder,
    targetDurationSeconds = Math.ceil(config.segmentDurationMs / 1000.0).toInt().coerceAtLeast(1),
  )

  private var encoder: AacEncoder? = null
  private var writer: AacSegmentWriter? = null
  private var segments: MutableList<RecordingSegment> = seededSegments.toMutableList()
  private var nextSegmentIndex: Int = seededNextIndex
  private var totalSamples: Long = (seededMediaMs / 1000.0 * sampleRateInt).toLong()
  private var lastPermission: AnvilPermissionStatus = AnvilPermission.status(context, context.currentActivity)
  private var lastInterruptionReason: AnvilInterruptionReason = AnvilInterruptionReason.OTHER
  private var pendingDiscontinuityForResume: Boolean = resumingFromExisting
  private var storageWarned: Boolean = false

  private val pcmListeners = ListenerRegistry<PCMChunk>()
  private val speakerListeners = ListenerRegistry<SpeakerWindow>()
  private val interruptionListeners = ListenerRegistry<AnvilInterruptionEvent>()
  private val routeListeners = ListenerRegistry<RouteChangeEvent>()
  private val permissionListeners = ListenerRegistry<AnvilPermissionStatus>()
  private val storageListeners = ListenerRegistry<StorageWarningEvent>()
  private val segmentListeners = ListenerRegistry<RecordingSegment>()
  private val manifestListeners = ListenerRegistry<String>()
  private val errorListeners = ListenerRegistry<RecorderError>()

  private val chunker = PcmChunker(sampleRateInt, config.streamChunkMs) { chunk -> pcmListeners.emit(chunk) }
  private val speakerWindows = SpeakerWindowAssembler(
    sampleRate = sampleRateInt,
    windowMs = config.speakerWindowMs,
    hopMs = config.speakerWindowHopMs,
  ) { window -> speakerListeners.emit(window) }

  private val resumeRetryDelaysMs: List<Long> = listOf(200L, 400L, 800L, 1600L, 3200L)

  // MARK: - Spec properties

  override val recordingId: String get() = config.recordingId
  override val folderPath: String get() = folder.absolutePath
  override val manifestPath: String get() = manifestWriter.manifestPath
  override var state: RecorderState = RecorderState.IDLE
    private set
  override var totalDurationMs: Double = seededMediaMs
    private set
  override var currentSegmentPath: String = ""
    private set

  init {
    focus.onInterruptionBegan = { reason -> handler.post { handleInterruptionBegan(reason) } }
    focus.onInterruptionEnded = { shouldResume -> handler.post { handleInterruptionEnded(shouldResume) } }
    focus.onRouteChanged = { reason, name ->
      handler.post { handleRouteChanged(reason, name) }
    }
  }

    /**
   * Seed the manifest writer with entries recovered from an existing unsealed manifest,
   * so a resumed recording's appends land AFTER the earlier session's segments and
   * seal() includes them. Called by the factory immediately after construction, before
   * start(). Internal — same module as the factory, so it doesn't leak from the public
   * Nitro surface.
   */
  internal fun seedManifest(entries: List<HlsManifestWriter.Entry>) {
    if (entries.isNotEmpty()) {
      manifestWriter.seed(existingEntries = entries, sealed = false)
    }
  }

  fun memorySize(): Long {
    // One AAC encoder (a few hundred KB of native buffers) + the pending PCM ring +
    // segment writer + chunker buffer. Order of magnitude is enough for the JS VM to
    // account for the recorder under memory pressure.
    return 1_500_000L
  }

  // MARK: - Spec methods (JS thread → owner thread)

  override fun start(): Promise<Unit> = handler.promise { performStart() }
  override fun pause(): Promise<Unit> = handler.promise { performPause() }
  override fun resume(): Promise<Unit> = handler.promise { performResume() }
  override fun stop(): Promise<Array<RecordingSegment>> = handler.promise {
    performStop().toTypedArray()
  }
  override fun rotateSegment(): Promise<RecordingSegment> = handler.promise {
    performRotate(routeChanged = false)
  }
  override fun markSegmentUploaded(filename: String): Promise<Unit> = handler.promise {
    UploadSentinelStore.mark(folder, filename)
  }

  override fun addPCMListener(listener: (PCMChunk) -> Unit): AnvilListenerSubscription = subscribe(pcmListeners, listener)
  override fun addSpeakerWindowListener(listener: (SpeakerWindow) -> Unit): AnvilListenerSubscription = subscribe(speakerListeners, listener)
  override fun addInterruptionListener(listener: (AnvilInterruptionEvent) -> Unit): AnvilListenerSubscription = subscribe(interruptionListeners, listener)
  override fun addRouteChangeListener(listener: (RouteChangeEvent) -> Unit): AnvilListenerSubscription = subscribe(routeListeners, listener)
  override fun addPermissionChangeListener(listener: (AnvilPermissionStatus) -> Unit): AnvilListenerSubscription = subscribe(permissionListeners, listener)
  override fun addStorageWarningListener(listener: (StorageWarningEvent) -> Unit): AnvilListenerSubscription = subscribe(storageListeners, listener)
  override fun addSegmentCompletedListener(listener: (RecordingSegment) -> Unit): AnvilListenerSubscription = subscribe(segmentListeners, listener)
  override fun addManifestUpdatedListener(listener: (String) -> Unit): AnvilListenerSubscription = subscribe(manifestListeners, listener)
  override fun addErrorListener(listener: (RecorderError) -> Unit): AnvilListenerSubscription = subscribe(errorListeners, listener)

  private fun <Event> subscribe(
    registry: ListenerRegistry<Event>,
    listener: (Event) -> Unit,
  ): AnvilListenerSubscription {
    val id = registry.add(listener)
    return AnvilListenerSubscription(remove = { registry.remove(id) })
  }

  // MARK: - Lifecycle (owner thread)

  private fun performStart() {
    if (state != RecorderState.IDLE) {
      throw AnvilException(RecorderErrorCode.STATE, "start() is only valid in idle state (now $state)")
    }
    checkPermission()
    if (!folder.exists() && !folder.mkdirs()) {
      throw AnvilException(RecorderErrorCode.IO, "Cannot create ${folder.absolutePath}")
    }
    if (config.keepAwakeInBackground) {
      val notif = config.notification
        ?: throw AnvilException(RecorderErrorCode.STATE, "notification is required with keepAwakeInBackground")
      AnvilRecordingService.start(context.applicationContext, notif.title, notif.text)
    }
    if (pendingDiscontinuityForResume) {
      manifestWriter.markDiscontinuity()
      pendingDiscontinuityForResume = false
    }
    openSegment()
    startCapture()
    focus.acquire(capture.audioSessionId)
    checkStorage()
    state = RecorderState.RECORDING
  }

  private fun performPause() {
    if (state != RecorderState.RECORDING) {
      throw AnvilException(RecorderErrorCode.STATE, "pause() is only valid while recording (now $state)")
    }
    capture.stop()
    focus.release()
    closeSegment(flushStreams = true, flushEncoder = true)
    state = RecorderState.PAUSED
  }

  private fun performResume() {
    if (state != RecorderState.PAUSED && state != RecorderState.INTERRUPTED) {
      throw AnvilException(RecorderErrorCode.STATE, "resume() is only valid from paused or interrupted (now $state)")
    }
    checkPermission()
    if (state == RecorderState.INTERRUPTED) {
      manifestWriter.markDiscontinuity()
    }
    openSegment()
    startCapture()
    focus.acquire(capture.audioSessionId)
    state = RecorderState.RECORDING
  }

  private fun performStop(): List<RecordingSegment> {
    if (state == RecorderState.STOPPED) return segments
    capture.stop()
    focus.release()
    if (writer != null) {
      closeSegment(flushStreams = true, flushEncoder = true)  // drains + releases encoder
    } else {
      // No open segment but an encoder may still exist (e.g. stopped while paused).
      try { encoder?.release() } catch (_: Exception) {}
      encoder = null
    }
    manifestWriter.seal()
    manifestListeners.emit(manifestPath)
    if (config.keepAwakeInBackground) {
      AnvilRecordingService.stop(context.applicationContext)
    }
    state = RecorderState.STOPPED
    return segments
  }

  private fun performRotate(routeChanged: Boolean): RecordingSegment {
    if (state != RecorderState.RECORDING || writer == null) {
      throw AnvilException(RecorderErrorCode.STATE, "rotateSegment() is only valid while recording")
    }
    writer!!.routeChanged = routeChanged
    if (routeChanged) {
      manifestWriter.markDiscontinuity()
    }
    val finished = closeSegment(flushStreams = routeChanged, flushEncoder = false)
    openSegment()
    checkStorage()
    return finished
  }

  // MARK: - Segments

  private fun openSegment() {
   val filename = String.format("%05d.aac", nextSegmentIndex)
    val file = File(folder, filename)
    // Backstop: never open over an existing segment. If this fires, indexing is wrong
    // upstream — fail loudly instead of truncating recorded audio.
    if (file.exists()) {
      throw AnvilException(RecorderErrorCode.STATE, "Refusing to overwrite existing segment $filename — index collision")
    }
    
    val mediaStartMs = totalSamples.toDouble() / sampleRateInt.toDouble() * 1000.0
    if (encoder == null) {
      encoder = AacEncoder(sampleRate = sampleRateInt, bitrate = config.aacBitrate.toInt())
    }
    writer = AacSegmentWriter(
      file = file,
      index = nextSegmentIndex,
      sampleRate = sampleRateInt,
      mediaStartMs = mediaStartMs,
      fsyncIntervalMs = config.fsyncIntervalMs,
      aacBitrate = config.aacBitrate.toInt(),
    )
    nextSegmentIndex++
    currentSegmentPath = file.absolutePath
  }

  /**
   * Closes the current segment. `flushEncoder` drains the encoder (which on Android
   * sends BUFFER_FLAG_END_OF_STREAM, silence-pads the tail, and kills the MediaCodec)
   * AND releases it — do this ONLY at true end-of-capture (stop / pause / interruption
   * / route change). At a plain time-based rotation pass `false`: the same MediaCodec
   * keeps running and its <1024-sample tail rolls into the next segment. Draining at
   * every rotation rebuilt the codec 10x/minute, re-priming its encoder delay each time
   * — that is the robotic/static bug.
   */
  private fun closeSegment(flushStreams: Boolean, flushEncoder: Boolean): RecordingSegment {
    val current = writer ?: throw AnvilException(RecorderErrorCode.STATE, "No open segment")
    if (flushStreams) {
      chunker.flush()
      speakerWindows.reset()
    }

    if (flushEncoder) {
      val enc = encoder
      if (enc != null) {
        try {
          for (frame in enc.drain()) {
            current.append(frame)
          }
        } catch (e: Exception) {
          current.abandon()
          writer = null
          currentSegmentPath = ""
          try { enc.release() } catch (_: Exception) {}
          encoder = null
          throw AnvilException(RecorderErrorCode.IO, "Writing tail frame to ${current.file.name} failed: ${e.message}")
        }
        try { enc.release() } catch (_: Exception) {}
        encoder = null
      }
    }

    writer = null
    currentSegmentPath = ""
    val finished = try {
      current.complete()
    } catch (e: Exception) {
      current.abandon()
      throw AnvilException(RecorderErrorCode.IO, "Finalizing ${current.file.name} failed: ${e.message}")
    }
    segments.add(finished)
    segmentListeners.emit(finished)
    manifestWriter.appendSegment(filename = finished.filename, durationMs = finished.durationMs)
    manifestListeners.emit(manifestPath)
    return finished
  }

  // MARK: - Capture

  private fun startCapture() {
    try {
      capture.start()
    } catch (e: AnvilException) {
      throw e
    } catch (e: Exception) {
      throw AnvilException(RecorderErrorCode.ENGINE, "Capture start failed: ${e.message}")
    }
  }

  /**
   * PCM fanout runs FIRST so STT and the speaker embedder never wait on encoding or
   * disk. Media time advances after the fanout. Encoding + segment write happen last;
   * their failure surfaces as `RecorderError` and stops capture, but the PCM chunk
   * that triggered the failure has already reached the listeners.
   */
  private fun handlePcm(samples: ShortArray, count: Int) {
    if (state != RecorderState.RECORDING) return
    val bytes = samples.toLittleEndianBytes(count)

    // 1. Fanout — synchronous, cheap.
    chunker.append(bytes, bytes.size, totalSamples)
    speakerWindows.append(samples, count, totalSamples)
    totalSamples += count
    totalDurationMs = totalSamples.toDouble() / sampleRateInt.toDouble() * 1000.0

    // 2. Encode + write.
    val currentWriter = writer
    val currentEncoder = encoder
    if (currentWriter == null || currentEncoder == null) return
    try {
      for (frame in currentEncoder.encode(samples, count)) {
        currentWriter.append(frame)
      }
    } catch (e: Exception) {
      val code = if (freeBytes() < 1_048_576) RecorderErrorCode.STORAGE else RecorderErrorCode.IO
      fail(code, "Writing ${currentWriter.file.name} failed: ${e.message}")
      return
    }

    // 3. Time-based rotation. Does NOT flush the encoder — the tail rolls forward.
    if (currentWriter.durationMs >= config.segmentDurationMs) {
      try {
        closeSegment(flushStreams = false, flushEncoder = false)
        openSegment()
        checkStorage()
      } catch (e: Exception) {
        fail(RecorderErrorCode.IO, "Segment rotation failed: ${e.message}")
      }
    }
  }

  // MARK: - Session events (owner thread)

  private fun handleInterruptionBegan(reason: AnvilInterruptionReason) {
    if (state != RecorderState.RECORDING) return
    capture.stop()
    focus.release()
    writer?.wasInterrupted = true
    writer?.interruptionReason = reason
    lastInterruptionReason = reason
    var path = ""
    try {
      path = closeSegment(flushStreams = true, flushEncoder = true).filePath
    } catch (e: Exception) {
      emitError(RecorderErrorCode.IO, "Finalizing on interruption failed: ${e.message}")
    }
    state = RecorderState.INTERRUPTED
    interruptionListeners.emit(
      AnvilInterruptionEvent(
        phase = AnvilInterruptionPhase.BEGAN,
        reason = reason,
        shouldResume = false,
        segmentPath = path,
        timestampMs = totalDurationMs,
      )
    )
  }

  private fun handleInterruptionEnded(shouldResume: Boolean) {
    if (state != RecorderState.INTERRUPTED) return

    interruptionListeners.emit(
      AnvilInterruptionEvent(
        phase = AnvilInterruptionPhase.ENDED,
        reason = lastInterruptionReason,
        shouldResume = shouldResume,
        segmentPath = "",
        timestampMs = totalDurationMs,
      )
    )
    if (config.onInterruption != InterruptionPolicy.RESUME || !shouldResume) return
    attemptResumeWithBackoff(0)
  }

  private fun attemptResumeWithBackoff(attempt: Int) {
    try {
      performResume()
    } catch (e: Exception) {
      if (attempt >= resumeRetryDelaysMs.size) {
        emitError(
          RecorderErrorCode.ENGINE,
          "Auto-resume failed after ${resumeRetryDelaysMs.size} attempts: ${e.message}"
        )
        return
      }
      val delay = resumeRetryDelaysMs[attempt]
      handler.postDelayed({ attemptResumeWithBackoff(attempt + 1) }, delay)
    }
  }

  private fun handleRouteChanged(reason: RouteChangeReason, inputName: String) {
    // Android's route callbacks don't tell us if the ACTIVE input actually swapped —
    // they only fire on device connect/disconnect. We rotate on any input-side change,
    // matching what a user would expect (segments never mix headphones + built-in mic).
    routeListeners.emit(
      RouteChangeEvent(
        reason = reason,
        inputName = inputName,
        inputChanged = true,
        timestampMs = totalDurationMs,
      )
    )
    if (state != RecorderState.RECORDING) return
    try {
      performRotate(routeChanged = true)
    } catch (e: Exception) {
      fail(RecorderErrorCode.IO, "Segment rotation after route change failed: ${e.message}")
    }
  }

  // MARK: - Checks and failure

  private fun checkPermission() {
    val status = AnvilPermission.status(context, context.currentActivity)
    if (status != lastPermission) {
      lastPermission = status
      permissionListeners.emit(status)
    }
    if (status != AnvilPermissionStatus.GRANTED) {
      throw AnvilException(RecorderErrorCode.PERMISSION, "Microphone permission is $status")
    }
  }

  private fun checkStorage() {
    val free = freeBytes()
    val below = free < config.storageWarningBytes
    if (below && !storageWarned) {
      storageWarned = true
      storageListeners.emit(StorageWarningEvent(freeBytes = free.toDouble(), thresholdBytes = config.storageWarningBytes))
    } else if (!below) {
      storageWarned = false
    }
  }

  private fun freeBytes(): Long {
    return try {
      val stat = StatFs(folder.absolutePath.takeIf { folder.exists() } ?: folder.parent!!)
      stat.availableBytes
    } catch (_: Exception) {
      Long.MAX_VALUE
    }
  }

  /**
   * Stops capture, secures whatever's on disk, moves to `interrupted` and reports the
   * error. The unsealed manifest reflects the last successfully-finalized segment;
   * discovery on next launch picks it up.
   */
  private fun fail(code: RecorderErrorCode, message: String) {
    capture.stop()
    focus.release()
    val currentWriter = writer
    if (currentWriter != null) {
      writer = null
      currentSegmentPath = ""
      chunker.flush()
      speakerWindows.reset()
      val finished = try {
        currentWriter.complete()
      } catch (_: Exception) {
        currentWriter.abandon()
        null
      }
      if (finished != null) {
        segments.add(finished)
        segmentListeners.emit(finished)
        try {
          manifestWriter.appendSegment(filename = finished.filename, durationMs = finished.durationMs)
          manifestListeners.emit(manifestPath)
        } catch (_: Exception) {}
      }
    }
    try { encoder?.release() } catch (_: Exception) {}
    encoder = null
    if (state == RecorderState.RECORDING) {
      state = RecorderState.INTERRUPTED
    }
    emitError(code, message)
  }

  private fun emitError(code: RecorderErrorCode, message: String) {
    errorListeners.emit(RecorderError(code = code, message = message, timestampMs = totalDurationMs))
  }
}