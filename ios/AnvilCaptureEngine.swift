import AVFoundation
import Foundation

/// Owns one AVAudioEngine with an input tap that converts to the target format and forwards
/// interleaved Int16 mono PCM. `start()` always builds a fresh engine, so route/format changes
/// and post-interruption tap failures are handled by a full rebuild.
final class AnvilCaptureEngine {
  private let targetFormat: AVAudioFormat
  private let onPCM: (Data) -> Void
  private let onConfigurationChange: () -> Void
  private var engine: AVAudioEngine?
  private var configurationObserver: NSObjectProtocol?

  init(sampleRate: Double, onPCM: @escaping (Data) -> Void, onConfigurationChange: @escaping () -> Void) throws {
    guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true) else {
      throw AnvilError(.engine, "Unsupported sample rate \(sampleRate)")
    }
    self.targetFormat = format
    self.onPCM = onPCM
    self.onConfigurationChange = onConfigurationChange
  }

  func start() throws {
    stop()
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
      throw AnvilError(.engine, "No audio input is available")
    }
    guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
      throw AnvilError(.engine, "Cannot convert \(inputFormat.sampleRate) Hz input to \(targetFormat.sampleRate) Hz")
    }
    let target = targetFormat
    let forward = onPCM
    let ratio = target.sampleRate / inputFormat.sampleRate
    input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
      guard let converted = AnvilCaptureEngine.convert(buffer, with: converter, to: target, ratio: ratio) else { return }
      forward(converted)
    }
    configurationObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
    ) { [weak self] _ in
      self?.onConfigurationChange()
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      throw AnvilError(.engine, "AVAudioEngine failed to start: \(error.localizedDescription)")
    }
    self.engine = engine
  }

  func stop() {
    if let observer = configurationObserver {
      NotificationCenter.default.removeObserver(observer)
      configurationObserver = nil
    }
    guard let engine = engine else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    self.engine = nil
  }

  private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat, ratio: Double) -> Data? {
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var consumed = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, outStatus in
      if consumed {
        outStatus.pointee = .noDataNow
        return nil
      }
      consumed = true
      outStatus.pointee = .haveData
      return buffer
    }
    guard status != .error, error == nil, output.frameLength > 0, let channels = output.int16ChannelData else { return nil }
    return Data(bytes: channels[0], count: Int(output.frameLength) * MemoryLayout<Int16>.size)
  }
}
