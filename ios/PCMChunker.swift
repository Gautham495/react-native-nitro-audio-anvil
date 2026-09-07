import Foundation
import NitroModules

/// Batches PCM into fixed-size chunks for the streaming listener. Sequence numbers span the whole session.
final class PCMChunker {
  private let chunkBytes: Int
  private let sampleRate: Int
  private var pending = Data()
  private var pendingStartSamples = 0
  private var sequence = 0
  private let onChunk: (PCMChunk) -> Void

  init(sampleRate: Int, chunkMs: Double, onChunk: @escaping (PCMChunk) -> Void) {
    self.sampleRate = sampleRate
    self.chunkBytes = max(2, Int(Double(sampleRate * 2) * chunkMs / 1000.0) & ~1)
    self.onChunk = onChunk
  }

  /// `mediaSamples` is the timeline position of the first sample in `pcm`.
  func append(_ pcm: Data, mediaSamples: Int) {
    if pending.isEmpty {
      pendingStartSamples = mediaSamples
    }
    pending.append(pcm)
    while pending.count >= chunkBytes {
      emit(pending.prefix(chunkBytes))
      pending.removeFirst(chunkBytes)
      pendingStartSamples += chunkBytes / 2
    }
  }

  /// Emits whatever is pending. Called on pause, interruption and stop so no audio is withheld.
  func flush() {
    guard !pending.isEmpty else { return }
    emit(pending)
    pending.removeAll(keepingCapacity: true)
  }

  private func emit(_ data: Data) {
      let samples = data.count / 2

      do {
          let chunk = try PCMChunk(
              buffer: ArrayBuffer.copy(data: Data(data)),
              timestampMs: Double(pendingStartSamples) / Double(sampleRate) * 1000.0,
              durationMs: Double(samples) / Double(sampleRate) * 1000.0,
              sequenceNumber: Double(sequence)
          )

          sequence += 1
          onChunk(chunk)

      } catch {
          print("❌ Failed to create PCMChunk: \(error)")
      }
  }
}
