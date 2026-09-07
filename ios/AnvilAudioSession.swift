import AVFoundation
import Foundation

/// Configures AVAudioSession for recording and forwards session notifications to closures
/// that are always invoked on the owner queue.
final class AnvilAudioSession {
  private let queue: DispatchQueue
  private let callObserver = AnvilCallObserver()
  private var observers: [NSObjectProtocol] = []
  private var lastInputUID = ""

  var onInterruptionBegan: ((AnvilInterruptionReason) -> Void)?
  var onInterruptionEnded: ((Bool) -> Void)?
  var onRouteChanged: ((RouteChangeReason, String, Bool) -> Void)?
  var onMediaServicesReset: (() -> Void)?

  init(queue: DispatchQueue) {
    self.queue = queue
  }

  func activate(preferredSampleRate: Double) throws {
    let session = AVAudioSession.sharedInstance()
    do {
      // `.allowBluetooth` is deprecated in the iOS 26 SDK in favour of `.allowBluetoothHFP`;
      // it still compiles and behaves identically. Switch once your minimum SDK is 26.
      try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .defaultToSpeaker])
      try session.setPreferredSampleRate(preferredSampleRate)
      try session.setActive(true, options: [])
    } catch {
      throw AnvilError(.session, "AVAudioSession activation failed: \(error.localizedDescription)")
    }
    lastInputUID = session.anvilCurrentInputUID
    if observers.isEmpty {
      startObserving()
    }
  }

  func deactivate() {
    stopObserving()
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
  }

  private func startObserving() {
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] notification in
      self?.handleInterruption(notification)
    })
    observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] notification in
      self?.handleRouteChange(notification)
    })
    observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) { [weak self] _ in
      self?.queue.async { self?.onMediaServicesReset?() }
    })
  }

  private func stopObserving() {
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }
    observers.removeAll()
  }

  private func handleInterruption(_ notification: Notification) {
    guard let type = notification.anvilInterruptionType else { return }
    switch type {
    case .began:
      let reason = callObserver.hasActiveCall ? AnvilInterruptionReason.call : notification.anvilInterruptionReason
      queue.async { [weak self] in self?.onInterruptionBegan?(reason) }
    case .ended:
      let shouldResume = notification.anvilShouldResume
      queue.async { [weak self] in self?.onInterruptionEnded?(shouldResume) }
    @unknown default:
      break
    }
  }

  private func handleRouteChange(_ notification: Notification) {
    let reason = RouteChangeReason.from(notification.anvilRouteChangeReason)
    let session = AVAudioSession.sharedInstance()
    let uid = session.anvilCurrentInputUID
    let name = session.anvilCurrentInputName
    queue.async { [weak self] in
      guard let self = self else { return }
      let changed = uid != self.lastInputUID
      self.lastInputUID = uid
      self.onRouteChanged?(reason, name, changed)
    }
  }
}
