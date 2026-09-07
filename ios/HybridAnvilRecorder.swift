import AVFoundation
import Foundation
import NitroModules

/// One recording session. All mutable state lives on `queue`; JS-facing methods hop onto it
/// through `Promise.parallel`, native callbacks are already delivered on it.
final class HybridAnvilRecorder: HybridAnvilRecorderSpec {
  private let config: RecorderConfig
  private let queue = DispatchQueue(label: "ai.nitroaudio.anvil.recorder")
  private let directory: URL
  private let sampleRate: Int
  private let session: AnvilAudioSession
  private var engine: AnvilCaptureEngine?
  private var writer: WavSegmentWriter?
  private var segments: [RecordingSegment] = []
  private var nextSegmentIndex = 0
  private var totalSamples = 0
  private var lastPermission: AnvilPermissionStatus
  private var lastInterruptionReason: AnvilInterruptionReason = .other

  private let pcmListeners = ListenerRegistry<PCMChunk>()
  private let speakerListeners = ListenerRegistry<SpeakerWindow>()
  private let interruptionListeners = ListenerRegistry<AnvilInterruptionEvent>()
  private let routeListeners = ListenerRegistry<RouteChangeEvent>()
  private let permissionListeners = ListenerRegistry<AnvilPermissionStatus>()
  private let storageListeners = ListenerRegistry<StorageWarningEvent>()
  private let segmentListeners = ListenerRegistry<RecordingSegment>()
  private let errorListeners = ListenerRegistry<RecorderError>()

  private lazy var chunker = PCMChunker(sampleRate: sampleRate, chunkMs: config.streamChunkMs) { [weak self] chunk in
    self?.pcmListeners.emit(chunk)
  }

  private lazy var speakerWindows = SpeakerWindowAssembler(
    sampleRate: sampleRate, windowMs: config.speakerWindowMs, hopMs: config.speakerWindowHopMs
  ) { [weak self] window in
    self?.speakerListeners.emit(window)
  }

  // MARK: - Spec properties (snapshots, readable from the JS thread)

  private(set) var sessionId: String
  private(set) var state: RecorderState = .idle
  private(set) var totalDurationMs: Double = 0
  private(set) var currentSegmentPath: String = ""

  init(config: RecorderConfig) {
    self.config = config
    self.directory = URL.anvilDirectory(config.outputDirectory)
    self.sampleRate = Int(config.sampleRate)
    self.sessionId = "anvil-\(Int(Date().timeIntervalSince1970 * 1000))"
    self.session = AnvilAudioSession(queue: queue)
    self.lastPermission = AVAudioSession.sharedInstance().anvilPermissionStatus
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

  func extractRange(startMs: Double, endMs: Double) throws -> Promise<String> {
    return Promise.parallel(queue) { try self.performExtract(startMs: startMs, endMs: endMs) }
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
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data().write(to: OrphanScanner.markerURL(directory: directory, sessionId: sessionId))
    try session.activate(preferredSampleRate: config.sampleRate)
    checkStorage()
    try openSegment()
    try startEngine()
    state = .recording
  }

  private func performPause() throws {
    guard state == .recording else { throw AnvilError(.state, "pause() is only valid while recording (now \(state))") }
    engine?.stop()
    try closeSegment(flushStreams: true)
    state = .paused
  }

  private func performResume() throws {
    guard state == .paused || state == .interrupted else {
      throw AnvilError(.state, "resume() is only valid from paused or interrupted (now \(state))")
    }
    try checkPermission()
    try session.activate(preferredSampleRate: config.sampleRate)
    try openSegment()
    try startEngine()
    state = .recording
  }

  private func performStop() throws -> [RecordingSegment] {
    guard state != .stopped else { return segments }
    engine?.stop()
    engine = nil
    if writer != nil {
      try closeSegment(flushStreams: true)
    }
    session.deactivate()
    try? FileManager.default.removeItem(at: OrphanScanner.markerURL(directory: directory, sessionId: sessionId))
    state = .stopped
    return segments
  }

  private func performRotate(routeChanged: Bool) throws -> RecordingSegment {
    guard state == .recording, writer != nil else { throw AnvilError(.state, "rotateSegment() is only valid while recording") }
    writer?.routeChanged = routeChanged
    let finished = try closeSegment(flushStreams: routeChanged)
    try openSegment()
    checkStorage()
    return finished
  }

  private func performExtract(startMs: Double, endMs: Double) throws -> String {
    var sources = segments.map {
      RangeSource(url: URL(fileURLWithPath: $0.filePath), mediaStartMs: $0.mediaStartMs, dataBytes: Int($0.fileSize) - WavHeader.byteCount)
    }
    if let writer = writer {
      try writer.flush()
      sources.append(RangeSource(url: writer.url, mediaStartMs: writer.mediaStartMs, dataBytes: writer.dataBytes))
    }
    let url = directory.appendingPathComponent("\(sessionId)_extract_\(Int(startMs))_\(Int(endMs)).wav")
    try RangeExtractor.extract(sources: sources, sampleRate: sampleRate, startMs: startMs, endMs: endMs, to: url)
    return url.path
  }

  // MARK: - Segments (owner queue)

  private func openSegment() throws {
    let name = "\(sessionId)-" + String(format: "%05d", nextSegmentIndex) + ".wav"
    let url = directory.appendingPathComponent(name)
    let mediaStartMs = Double(totalSamples) / Double(sampleRate) * 1000.0
    writer = try WavSegmentWriter(
      url: url, index: nextSegmentIndex, sampleRate: sampleRate, mediaStartMs: mediaStartMs, fsyncIntervalMs: config.fsyncIntervalMs
    )
    nextSegmentIndex += 1
    currentSegmentPath = url.path
  }

  @discardableResult
  private func closeSegment(flushStreams: Bool) throws -> RecordingSegment {
    guard let writer = writer else { throw AnvilError(.state, "No open segment") }
    if flushStreams {
      chunker.flush()
      speakerWindows.reset()
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

  private func handlePCM(_ data: Data) {
    guard state == .recording, let writer = writer else { return }
    let startSamples = totalSamples
    do {
      try writer.append(data)
    } catch {
      let code: RecorderErrorCode = FileManager.default.anvilFreeBytes(at: directory) < 1_048_576 ? .storage : .io
      fail(code, "Writing \(writer.url.lastPathComponent) failed: \(error.localizedDescription)")
      return
    }
    totalSamples += data.count / 2
    totalDurationMs = Double(totalSamples) / Double(sampleRate) * 1000.0
    chunker.append(data, mediaSamples: startSamples)
    speakerWindows.append(data, mediaSamples: startSamples)
    if writer.durationMs >= config.segmentDurationMs {
      do {
        try closeSegment(flushStreams: false)
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
      path = try closeSegment(flushStreams: true).filePath
    } catch {
      emitError(.io, "Finalizing on interruption failed: \(error.localizedDescription)")
    }
    state = .interrupted
    interruptionListeners.emit(AnvilInterruptionEvent(
      phase: .began, reason: reason, shouldResume: false, segmentPath: path, timestampMs: totalDurationMs
    ))
  }

  private func handleInterruptionEnded(_ shouldResume: Bool) {
    guard state == .interrupted else { return }
    interruptionListeners.emit(AnvilInterruptionEvent(
      phase: .ended, reason: lastInterruptionReason, shouldResume: shouldResume, segmentPath: "", timestampMs: totalDurationMs
    ))
    guard config.onInterruption == .resume, shouldResume else { return }
    do {
      try performResume()
    } catch {
      emitError(.engine, "Auto-resume after interruption failed: \(error.localizedDescription)")
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
      path = try closeSegment(flushStreams: true).filePath
    } catch {
      emitError(.io, "Finalizing on media services reset failed: \(error.localizedDescription)")
    }
    state = .interrupted
    interruptionListeners.emit(AnvilInterruptionEvent(phase: .began, reason: .reset, shouldResume: false, segmentPath: path, timestampMs: totalDurationMs))
    interruptionListeners.emit(AnvilInterruptionEvent(phase: .ended, reason: .reset, shouldResume: true, segmentPath: "", timestampMs: totalDurationMs))
    guard config.onInterruption == .resume else { return }
    do {
      try performResume()
    } catch {
      emitError(.session, "Auto-resume after media services reset failed: \(error.localizedDescription)")
    }
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
    let free = FileManager.default.anvilFreeBytes(at: directory)
    if Double(free) < config.storageWarningBytes {
      storageListeners.emit(StorageWarningEvent(freeBytes: Double(free), thresholdBytes: config.storageWarningBytes))
    }
  }

  /// Stops capture, secures whatever is on disk, moves to `interrupted` and reports the error.
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
      } else {
        writer.abandon()
      }
    }
    if state == .recording {
      state = .interrupted
    }
    emitError(code, message)
  }

  private func emitError(_ code: RecorderErrorCode, _ message: String) {
    errorListeners.emit(RecorderError(code: code, message: message, timestampMs: totalDurationMs))
  }
}
