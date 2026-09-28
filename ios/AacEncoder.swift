import AVFoundation
import Foundation

/// Encodes mono Int16 PCM at `sampleRate` to ADTS-wrapped AAC-LC frames at `bitrate`.
/// Owns one `AVAudioConverter`. All calls must happen on the recorder's owner queue.
///
/// AAC frames are 1024 samples each — at 16 kHz that's 64 ms per frame. The encoder
/// accumulates PCM until it has at least one frame's worth, then emits as many ADTS
/// frames as fit; leftover samples stay pending for the next `encode()` call.
final class AacEncoder {
  /// AAC-LC always produces 1024 samples per frame.
  static let framesPerAacFrame: AVAudioFrameCount = 1024

  private let sampleRate: Int
  private let bitrate: Int
  private let pcmFormat: AVAudioFormat
  private let aacFormat: AVAudioFormat
  private let converter: AVAudioConverter
  private var pending: [Int16] = []

  init(sampleRate: Int, bitrate: Int) throws {
    self.sampleRate = sampleRate
    self.bitrate = bitrate

    guard let pcmFormat = AVAudioFormat(
      commonFormat: .pcmFormatInt16,
      sampleRate: Double(sampleRate),
      channels: 1,
      interleaved: true
    ) else {
      throw AnvilError(.engine, "Cannot build PCM Int16 format at \(sampleRate) Hz")
    }
    self.pcmFormat = pcmFormat

    var aacDescription = AudioStreamBasicDescription(
      mSampleRate: Double(sampleRate),
      mFormatID: kAudioFormatMPEG4AAC,
      mFormatFlags: 0,
      mBytesPerPacket: 0,
      mFramesPerPacket: Self.framesPerAacFrame,
      mBytesPerFrame: 0,
      mChannelsPerFrame: 1,
      mBitsPerChannel: 0,
      mReserved: 0
    )
    guard let aacFormat = AVAudioFormat(streamDescription: &aacDescription) else {
      throw AnvilError(.engine, "Cannot build AAC-LC format at \(sampleRate) Hz")
    }
    self.aacFormat = aacFormat

     guard let converter = AVAudioConverter(from: pcmFormat, to: aacFormat) else {
      throw AnvilError(.engine, "Cannot create PCM→AAC converter at \(sampleRate) Hz")
    }
    // Simulator has no hardware AAC encoder; force software so init doesn't fail.
    // On device this is a no-op — hardware AAC also lives at priority 0.
    #if targetEnvironment(simulator)
    converter.bitRateStrategy = AVAudioBitRateStrategy_Constant
    #endif
    converter.bitRate = bitrate
    self.converter = converter
  }

  /// One ADTS-wrapped AAC frame the encoder has produced. `pcmSamples` is how many PCM
  /// input samples that frame covers (always 1024 for AAC-LC; kept explicit for clarity).
  struct Frame {
    let bytes: Data
    let pcmSamples: Int
  }

  /// Appends PCM to the pending buffer and drains as many AAC frames as fit. Returns the
  /// frames produced in call order. Leftover PCM (less than one AAC frame's worth) stays
  /// pending for the next call.
  func encode(_ pcm: Data) throws -> [Frame] {
    let newSamples = pcm.anvilInt16Samples
    pending.append(contentsOf: newSamples)
    return try drain(flush: false)
  }

  /// Encodes and returns any complete AAC frames plus, if there is a partial-frame
  /// remainder, one final frame padded with silence so no captured audio is lost at a
  /// segment boundary.
  func drain() throws -> [Frame] {
    return try drain(flush: true)
  }

  private func drain(flush: Bool) throws -> [Frame] {
    let framesPer = Int(Self.framesPerAacFrame)
    var out: [Frame] = []
    while pending.count >= framesPer {
      let chunk = Array(pending.prefix(framesPer))
      pending.removeFirst(framesPer)
      if let frame = try encodeOne(samples: chunk) {
        out.append(frame)
      }
    }
    if flush, !pending.isEmpty {
      var padded = pending
      padded.append(contentsOf: [Int16](repeating: 0, count: framesPer - padded.count))
      pending.removeAll(keepingCapacity: true)
      if let frame = try encodeOne(samples: padded) {
        out.append(frame)
      }
    }
    return out
  }

  private func encodeOne(samples: [Int16]) throws -> Frame? {
    let framesPer = AVAudioFrameCount(samples.count)
    guard let inputBuffer = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: framesPer) else {
      throw AnvilError(.engine, "Cannot allocate PCM input buffer")
    }
    inputBuffer.frameLength = framesPer
    guard let channels = inputBuffer.int16ChannelData else {
      throw AnvilError(.engine, "PCM buffer has no int16 channel data")
    }
    samples.withUnsafeBufferPointer { src in
      channels[0].update(from: src.baseAddress!, count: samples.count)
    }

    let outputBuffer = AVAudioCompressedBuffer(
      format: aacFormat,
      packetCapacity: 1,
      maximumPacketSize: 4096
    );

    var provided = false
    var convertError: NSError?
    let status = converter.convert(to: outputBuffer, error: &convertError) { _, outStatus in
      if provided {
        outStatus.pointee = .noDataNow
        return nil
      }
      provided = true
      outStatus.pointee = .haveData
      return inputBuffer
    }

    if let error = convertError {
      throw AnvilError(.engine, "AAC encode failed: \(error.localizedDescription)")
    }
    if status == .error {
      throw AnvilError(.engine, "AAC encode returned error status")
    }
    guard outputBuffer.packetCount == 1 else {
      // The encoder buffers internally on the first calls; empty output is normal until
      // it has enough context.
      return nil
    }

    let payloadSize = Int(outputBuffer.byteLength)
    let payload = Data(bytes: outputBuffer.data, count: payloadSize)
    let header = try AdtsHeader.bytes(sampleRate: sampleRate, channels: 1, aacFrameBytes: payloadSize)
    var frame = Data(capacity: header.count + payload.count)
    frame.append(header)
    frame.append(payload)
    return Frame(bytes: frame, pcmSamples: samples.count)
  }
}
