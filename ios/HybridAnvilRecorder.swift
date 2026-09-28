import AVFoundation
import Foundation
import NitroModules
import UIKit

/// One recording. All mutable state lives on `queue`; JS-facing methods hop onto it
/// through `Promise.parallel`, native callbacks are already delivered on it.
///
/// The recorder owns `${outputDirectory}/${recordingId}/` and everything inside it.
/// Live streams (PCM chunks, speaker windows) fan out first, synchronously; the AAC
/// encode + segment write + manifest update run afterwards on the same queue. A disk
/// stall never blocks the STT / embedder path — that's what "PCM is a separate track"
/// means for the on-device pipelines.
final class HybridAnvilRecorder: HybridAnvilRecorderSpec {
  private let config: RecorderConfig
  private let queue = DispatchQueue(label: "ai.nitroaudio.anvil.recorder")

  private let outputDirectory: URL
  private let folderURL: URL
  private let manifestWriter: HlsManifestWriter
  private let sampleRate: Int
  private let session: AnvilAudioSession

  private var engine: AnvilCaptureEngine?
  private var encoder: AacEncoder?
  private var writer: AacSegmentWriter?
  private var segments: [RecordingSegment] = []
  private var nextSegmentIndex = 0
  private var totalSamples = 0
  private var lastPermission: AnvilPermissionStatus
  private var lastInterruptionReason: AnvilInterruptionReason = .other
  private var pendingDiscontinuityForResume = false
  private var storageWarned = false

  private let pcmListeners = ListenerRegistry<PCMChunk>()
  private let speakerListeners = ListenerRegistry<SpeakerWindow>()
  private let interruptionListeners = ListenerRegistry<AnvilInterruptionEvent>()
  private let routeListeners = ListenerRegistry<RouteChangeEvent>()
  private let permissionListeners = ListenerRegistry<AnvilPermissionStatus>()
  private let storageListeners = ListenerRegistry<StorageWarningEvent>()
  private let segmentListeners = ListenerRegistry<RecordingSegment>()
  private let manifestListeners = ListenerRegistry<String>()
  private let errorListeners = ListenerRegistry<RecorderError>()
  private let resumeRetryDelays: [TimeInterval] = [0.2, 0.4, 0.8, 1.6, 3.2]

  private lazy var chunker = PCMChunker(sampleRate: sampleRate, chunkMs: config.streamChunkMs) { [weak self] chunk in
    self?.pcmListeners.emit(chunk)
  }

  private lazy var speakerWindows = SpeakerWindowAssembler(
    sampleRate: sampleRate, windowMs: config.speakerWindowMs, hopMs: config.speakerWindowHopMs
  ) { [weak self] window in
    self?.speakerListeners.emit(window)
  }

  // MARK: - Spec properties (snapshots)

  private(set) var recordingId: String
  private(set) var folderPath: String
  private(set) var manifestPath: String
  private(set) var state: RecorderState = .idle
  private(set) var totalDurationMs: Double = 0
  private(set) var currentSegmentPath: String = ""

  init(config: RecorderConfig, seededSegments: [RecordingSegment], seededNextIndex: Int, seededMediaMs: Double, resumingFromExisting: Bool, seededManifestEntries: [HlsManifestWriter.Entry] = []) {
   self.config = config
    self.outputDirectory = URL.anvilDirectory(config.outputDirectory)
    self.folderURL = outputDirectory.appendingPathComponent(config.recordingId)
    self.sampleRate = Int(config.sampleRate)
    self.recordingId = config.recordingId
    self.folderPath = folderURL.path
    self.session = AnvilAudioSession(queue: queue)
    self.lastPermission = AVAudioSession.sharedInstance().anvilPermissionStatus

    let targetSeconds = Int((config.segmentDurationMs / 1000.0).rounded(.up))
    self.manifestWriter = HlsManifestWriter(folderURL: folderURL, targetDurationSeconds: targetSeconds)
    self.manifestPath = manifestWriter.manifestPath

    // Seed the manifest writer with the recovered entries so resume appends land AFTER
    // the earlier session's segments and seal() includes them. Without this the resumed
    // manifest silently drops everything the previous session wrote.
    if !seededManifestEntries.isEmpty {
      manifestWriter.seed(existingEntries: seededManifestEntries, sealed: false)
    }

    self.segments = seededSegments
    self.nextSegmentIndex = seededNextIndex
    self.totalSamples = Int((seededMediaMs / 1000.0) * Double(sampleRate))
    self.totalDurationMs = seededMediaMs
    self.pendingDiscontinuityForResume = resumingFromExisting

    super.init()

    session.onInterruptionBegan = { [weak self] reason in self?.handleInterruptionBegan(reason) }
    session.onInterruptionEnded = { [weak self] shouldResume in self?.handleInterruptionEnded(shouldResume) }
    session.onRouteChanged = { [weak self] reason, name, changed in
      self?.handleRouteChanged(reason, inputName: name, inputChanged: changed)
    }
    session.onMediaServicesReset = { [weak self] in self?.handleMediaServicesReset() }
  }

  // MARK: - Spec methods

  func start() throws -> Promise<Void> {
    return Promise.parallel(queue) { try self.performStart() }
  }

  func pause() throws -> Promise<Void> {
    return Promise.parallel(queue) { try self.performPause() }
  }

  func resume() throws -> Promise<Void> {
    return Promise.parallel(queue) { try self.performResume() }
  }

  func stop() throws -> Promise<[RecordingSegment]> {
    return Promise.parallel(queue) { try self.performStop() }
  }

  func rotateSegment() throws -> Promise<RecordingSegment> {
    return Promise.parallel(queue) { try self.performRotate(routeChanged: false) }
  }

  func markSegmentUploaded(filename: String) throws -> Promise<Void> {
    return Promise.parallel(queue) {
      try UploadSentinelStore.mark(folder: self.folderURL, filename: filename)
    }
  }

  func addPCMListener(listener: @escaping (PCMChunk) -> Void) throws -> AnvilListenerSubscription {
    return subscribe(pcmListeners, listener)
  }

  func addSpeakerWindowListener(listener: @escaping (SpeakerWindow) -> Void) throws -> AnvilListenerSubscription {
    return subscribe(speakerListeners, listener)
  }

  func addInterruptionListener(listener: @escaping (AnvilInterruptionEvent) -> Void) throws -> AnvilListenerSubscription {
    return subscribe(interruptionListeners, listener)
  }

  func addRouteChangeListener(listener: @escaping (RouteChangeEvent) -> Void) throws -> AnvilListenerSubscription {
    return subscribe(routeListeners, listener)
  }

  func addPermissionChangeListener(listener: @escaping (AnvilPermissionStatus) -> Void) throws -> AnvilListenerSubscription {
    return subscribe(permissionListeners, listener)
  }

  func addStorageWarningListener(listener: @escaping (StorageWarningEvent) -> Void) throws -> AnvilListenerSubscription {
    return subscribe(storageListeners, listener)
  }

  func addSegmentCompletedListener(listener: @escaping (RecordingSegment) -> Void) throws -> AnvilListenerSubscription {
    return subscribe(segmentListeners, listener)
  }

  func addManifestUpdatedListener(listener: @escaping (String) -> Void) throws -> AnvilListenerSubscription {
    return subscribe(manifestListeners, listener)
  }

  func addErrorListener(listener: @escaping (RecorderError) -> Void) throws -> AnvilListenerSubscription {
    return subscribe(errorListeners, listener)
  }

  private func subscribe<Event>(_ registry: ListenerRegistry<Event>, _ listener: @escaping (Event) -> Void) -> AnvilListenerSubscription {
    let id = UUID()
    let queue = self.queue
    queue.async { registry.add(id, listener) }
    return AnvilListenerSubscription(remove: {
      queue.async { registry.remove(id) }
    })
  }

  // MARK: - Lifecycle (owner queue)

  private func performStart() throws {
    guard state == .idle else { throw AnvilError(.state, "start() is only valid in idle state (now \(state))") }
    try checkPermission()
    try FileManager.default.createDirectory(at: folderURL, withIntermediateDirectories: true)
    try session.activate(preferredSampleRate: config.sampleRate)
    checkStorage()
    if pendingDiscontinuityForResume {
      manifestWriter.markDiscontinuity()
      pendingDiscontinuityForResume = false
    }
    try openSegment()
    try startEngine()
    state = .recording
  }

  private func performPause() throws {
    guard state == .recording else { throw AnvilError(.state, "pause() is only valid while recording (now \(state))") }
    engine?.stop()
    try closeSegment(flushStreams: true, flushEncoder: true)
    state = .paused
  }

  private func performResume() throws {
    guard state == .paused || state == .interrupted else {
      throw AnvilError(.state, "resume() is only valid from paused or interrupted (now \(state))")
    }
    try checkPermission()
    try session.activate(preferredSampleRate: config.sampleRate)
    if state == .interrupted {
      manifestWriter.markDiscontinuity()
    }
    try openSegment()
    try startEngine()
    state = .recording
  }

  private func performStop() throws -> [RecordingSegment] {
    guard state != .stopped else { return segments }
    engine?.stop()
    engine = nil
    if writer != nil {
      try closeSegment(flushStreams: true, flushEncoder: true)
    }
    encoder = nil   // ARC releases the AVAudioConverter; no reuse after stop.
    session.deactivate()
    try manifestWriter.seal()
    manifestListeners.emit(manifestPath)
    state = .stopped
    return segments
  }

  private func performRotate(routeChanged: Bool) throws -> RecordingSegment {
    guard state == .recording, writer != nil else { throw AnvilError(.state, "rotateSegment() is only valid while recording") }
    writer?.routeChanged = routeChanged
    if routeChanged {
      manifestWriter.markDiscontinuity()
    }
    let finished = try closeSegment(flushStreams: routeChanged, flushEncoder: false)
    try openSegment()
    checkStorage()
    return finished
  }

  // MARK: - Segments (owner queue)

  private func openSegment() throws {
    let filename = String(format: "%05d.aac", nextSegmentIndex)
    let url = folderURL.appendingPathComponent(filename)
    // Backstop: never open over an existing segment. If this fires, indexing is wrong
    // upstream — fail loudly instead of truncating recorded audio.
    if FileManager.default.fileExists(atPath: url.path) {
      throw AnvilError(.state, "Refusing to overwrite existing segment \(filename) — index collision")
    }

    let mediaStartMs = Double(totalSamples) / Double(sampleRate) * 1000.0
    if encoder == nil {
      encoder = try AacEncoder(sampleRate: sampleRate, bitrate: Int(config.aacBitrate))
    }
    writer = try AacSegmentWriter(
      url: url,
      index: nextSegmentIndex,
      sampleRate: sampleRate,
      mediaStartMs: mediaStartMs,
      fsyncIntervalMs: config.fsyncIntervalMs,
      aacBitrate: Int(config.aacBitrate)
    )
    nextSegmentIndex += 1
    currentSegmentPath = url.path
  }

  /// Closes the current segment. `flushEncoder` drains the encoder's pending PCM
  /// (silence-padding the final partial frame) — do this ONLY at true end-of-capture
  /// (stop / pause / interruption / media-reset). At a plain rotation pass `false`:
  /// the encoder keeps running and its <1024-sample tail rolls into the next segment.
  /// Draining at every rotation silence-pads a partial frame 10x/minute — that is the
  /// robotic/static bug.
  @discardableResult
  private func closeSegment(flushStreams: Bool, flushEncoder: Bool) throws -> RecordingSegment {
    guard let writer = writer else { throw AnvilError(.state, "No open segment") }
    if flushStreams {
      chunker.flush()
      speakerWindows.reset()
    }

    if flushEncoder, let frames = try? encoder?.drain() {
      for frame in frames {
        do { try writer.append(frame: frame) } catch {
          writer.abandon()
          self.writer = nil
          currentSegmentPath = ""
          throw AnvilError(.io, "Writing tail frame to \(writer.url.lastPathComponent) failed: \(error.localizedDescription)")
        }
      }
    }

    self.writer = nil
    currentSegmentPath = ""
    let finished: RecordingSegment
    do {
      finished = try writer.finalize()
    } catch {
      writer.abandon()
      throw AnvilError(.io, "Finalizing \(writer.url.lastPathComponent) failed: \(error.localizedDescription)")
    }
    segments.append(finished)
    segmentListeners.emit(finished)
    try manifestWriter.appendSegment(filename: finished.filename, durationMs: finished.durationMs)
    manifestListeners.emit(manifestPath)
    return finished
  }

  // MARK: - Capture (owner queue)

  private func startEngine() throws {
    if engine == nil {
      engine = try AnvilCaptureEngine(
        sampleRate: config.sampleRate,
        onPCM: { [weak self] data in self?.queue.async { self?.handlePCM(data) } },
        onConfigurationChange: { [weak self] in self?.queue.async { self?.handleConfigurationChange() } }
      )
    }
    try engine?.start()
  }

  /// PCM fanout runs FIRST so STT and the speaker embedder never wait on encoding or
  /// disk. Media time advances after the fanout. Encoding + segment write happen last;
  /// their failure surfaces as `RecorderError` and stops capture, but the PCM chunk
  /// that triggered the failure has already reached the listeners.
  private func handlePCM(_ data: Data) {
    guard state == .recording else { return }
    let startSamples = totalSamples

    // 1. Fanout — synchronous, cheap.
    chunker.append(data, mediaSamples: startSamples)
    speakerWindows.append(data, mediaSamples: startSamples)
    totalSamples += data.count / 2
    totalDurationMs = Double(totalSamples) / Double(sampleRate) * 1000.0

    // 2. Encode + write — the "other track" the README talks about.
    guard let writer = writer, let encoder = encoder else { return }
    do {
      let frames = try encoder.encode(data)
      for frame in frames {
        try writer.append(frame: frame)
      }
    } catch {
      let code: RecorderErrorCode = FileManager.default.anvilFreeBytes(at: folderURL) < 1_048_576 ? .storage : .io
      fail(code, "Writing \(writer.url.lastPathComponent) failed: \(error.localizedDescription)")
      return
    }

    // 3. Time-based rotation. Does NOT flush the encoder — the tail rolls forward.
    if writer.durationMs >= config.segmentDurationMs {
      do {
        try closeSegment(flushStreams: false, flushEncoder: false)
        try openSegment()
        checkStorage()
      } catch {
        fail(.io, "Segment rotation failed: \(error.localizedDescription)")
      }
    }
  }

  private func handleConfigurationChange() {
    guard state == .recording else { return }
    do {
      try engine?.start()
    } catch {
      fail(.engine, "Capture engine restart failed: \(error.localizedDescription)")
    }
  }

  // MARK: - Session events (owner queue)

  private func handleInterruptionBegan(_ reason: AnvilInterruptionReason) {
    guard state == .recording else { return }
    engine?.stop()
    writer?.wasInterrupted = true
    writer?.interruptionReason = reason
    lastInterruptionReason = reason
    var path = ""
    do {
      path = try closeSegment(flushStreams: true, flushEncoder: true).filePath
    } catch {
      emitError(.io, "Finalizing on interruption failed: \(error.localizedDescription)")
    }
    state = .interrupted
    interruptionListeners.emit(AnvilInterruptionEvent(
      phase: .began, reason: reason, shouldResume: false, segmentPath: path, timestampMs: totalDurationMs
    ))
  }

  /// Handles both AVAudioSession interruption-ended AND mediaServicesWereReset. The
  /// backoff loop and foreground gate are identical for the two flows — a media-services
  /// reset also comes back to us as "the OS says you can try again", and the same iOS
  /// bug (background reactivation permanently blocked after phone calls) applies.
  private func handleInterruptionEnded(_ shouldResume: Bool) {
    guard state == .interrupted else { return }

    interruptionListeners.emit(AnvilInterruptionEvent(
      phase: .ended,
      reason: lastInterruptionReason,
      shouldResume: shouldResume,
      segmentPath: "",
      timestampMs: totalDurationMs
    ))

    guard config.onInterruption == .resume, shouldResume else { return }

    // Foreground check: iOS has a known bug where session activation fails permanently
    // in the background after phone-call interruptions. Retrying doesn't help — only
    // bringing the app foreground releases the lock.
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      let appState = UIApplication.shared.applicationState

      self.queue.async {
        guard appState == .active else {
          self.emitError(.engine, "Auto-resume deferred — bring app to foreground to continue")
          return
        }
        self.attemptResumeWithBackoff(attempt: 0)
      }
    }
  }

  private func attemptResumeWithBackoff(attempt: Int) {
    do {
      try performResume()
    } catch {
      guard attempt < resumeRetryDelays.count else {
        emitError(.engine, "Auto-resume failed after \(resumeRetryDelays.count) attempts: \(error.localizedDescription)")
        return
      }
      let delay = resumeRetryDelays[attempt]
      queue.asyncAfter(deadline: .now() + delay) { [weak self] in
        guard let self = self else { return }
        DispatchQueue.main.async {
          let appState = UIApplication.shared.applicationState
          self.queue.async {
            guard appState == .active else {
              self.emitError(.engine, "Auto-resume abandoned — app was backgrounded during retry")
              return
            }
            self.attemptResumeWithBackoff(attempt: attempt + 1)
          }
        }
      }
    }
  }

  private func handleRouteChanged(_ reason: RouteChangeReason, inputName: String, inputChanged: Bool) {
    routeListeners.emit(RouteChangeEvent(reason: reason, inputName: inputName, inputChanged: inputChanged, timestampMs: totalDurationMs))
    guard inputChanged, state == .recording else { return }
    do {
      _ = try performRotate(routeChanged: true)
    } catch {
      fail(.io, "Segment rotation after route change failed: \(error.localizedDescription)")
    }
  }

  /// Same path as an OS interruption: kill the engine, finalize the segment, emit began
  /// + ended, then let the unified backoff resume take it from there.
  private func handleMediaServicesReset() {
    guard state == .recording else {
      engine = nil
      return
    }
    engine?.stop()
    engine = nil
    writer?.wasInterrupted = true
    writer?.interruptionReason = .reset
    lastInterruptionReason = .reset
    var path = ""
    do {
      path = try closeSegment(flushStreams: true, flushEncoder: true).filePath
    } catch {
      emitError(.io, "Finalizing on media services reset failed: \(error.localizedDescription)")
    }
    state = .interrupted
    interruptionListeners.emit(AnvilInterruptionEvent(phase: .began, reason: .reset, shouldResume: false, segmentPath: path, timestampMs: totalDurationMs))
    handleInterruptionEnded(true)
  }

  // MARK: - Checks and failure (owner queue)

  private func checkPermission() throws {
    let status = AVAudioSession.sharedInstance().anvilPermissionStatus
    if status != lastPermission {
      lastPermission = status
      permissionListeners.emit(status)
    }
    guard status == .granted else { throw AnvilError(.permission, "Microphone permission is \(status)") }
  }

  private func checkStorage() {
    let free = FileManager.default.anvilFreeBytes(at: folderURL)
    let below = Double(free) < config.storageWarningBytes
    if below, !storageWarned {
      storageWarned = true
      storageListeners.emit(StorageWarningEvent(freeBytes: Double(free), thresholdBytes: config.storageWarningBytes))
    } else if !below {
      storageWarned = false
    }
  }

  /// Stops capture, secures whatever is on disk, moves to `interrupted` and reports the
  /// error. The unsealed manifest reflects the last successfully-finalized segment;
  /// discovery on next launch picks it up.
  private func fail(_ code: RecorderErrorCode, _ message: String) {
    engine?.stop()
    if let writer = writer {
      self.writer = nil
      currentSegmentPath = ""
      chunker.flush()
      speakerWindows.reset()
      if let finished = try? writer.finalize() {
        segments.append(finished)
        segmentListeners.emit(finished)
        try? manifestWriter.appendSegment(filename: finished.filename, durationMs: finished.durationMs)
        manifestListeners.emit(manifestPath)
      } else {
        writer.abandon()
      }
    }
    encoder = nil
    if state == .recording {
      state = .interrupted
    }
    emitError(code, message)
  }

  private func emitError(_ code: RecorderErrorCode, _ message: String) {
    errorListeners.emit(RecorderError(code: code, message: message, timestampMs: totalDurationMs))
  }
}