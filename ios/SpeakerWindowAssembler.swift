import Foundation
import NitroModules

/// Assembles overlapping fixed-length windows from the PCM stream for speaker embedding.
final class SpeakerWindowAssembler {
  private let sampleRate: Int
  private let windowSamples: Int
  private let hopSamples: Int
  private var ring: [Int16] = []
  private var samplesSinceEmit = 0
  private var endSamples = 0
  private var primed = false
  private let onWindow: (SpeakerWindow) -> Void

  init(sampleRate: Int, windowMs: Double, hopMs: Double, onWindow: @escaping (SpeakerWindow) -> Void) {
    self.sampleRate = sampleRate
    self.windowSamples = max(1, Int(Double(sampleRate) * windowMs / 1000.0))
    self.hopSamples = max(1, Int(Double(sampleRate) * hopMs / 1000.0))
    self.onWindow = onWindow
    ring.reserveCapacity(windowSamples)
  }

  /// `mediaSamples` is the timeline position of the first sample in `pcm`.
  func append(_ pcm: Data, mediaSamples: Int) {
    let samples = pcm.anvilInt16Samples
    if ring.isEmpty {
      endSamples = mediaSamples
    }
    ring.append(contentsOf: samples)
    endSamples += samples.count
    if ring.count > windowSamples {
      ring.removeFirst(ring.count - windowSamples)
    }
    samplesSinceEmit += samples.count
    guard ring.count == windowSamples else { return }
    if !primed || samplesSinceEmit >= hopSamples {
      primed = true
      samplesSinceEmit = 0
      emit()
    }
  }

  /// Drops buffered audio so a window never spans a pause or interruption.
  func reset() {
    ring.removeAll(keepingCapacity: true)
    samplesSinceEmit = 0
    primed = false
  }

  private func emit() {
  var sumSquares = 0.0
  for sample in ring { let value = Double(sample); sumSquares += value * value }
  let rms = (sumSquares / Double(ring.count)).squareRoot() / 32768.0
  let data = ring.withUnsafeBufferPointer { Data(buffer: $0) }
  let startSamples = endSamples - windowSamples
  do {
    let buffer = try ArrayBuffer.copy(data: data)
    onWindow(SpeakerWindow(
      buffer: buffer,
      startMs: Double(startSamples) / Double(sampleRate) * 1000.0,
      endMs: Double(endSamples) / Double(sampleRate) * 1000.0,
      rms: rms
    ))
  } catch {
    // Drop this window — next hop will emit again.
  }
}
}
