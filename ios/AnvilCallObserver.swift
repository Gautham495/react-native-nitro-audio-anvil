import CallKit
import Foundation

/// Answers "is a phone/VoIP call active right now?" so interruptions can be labelled `call`.
final class AnvilCallObserver {
  private let observer = CXCallObserver()

  var hasActiveCall: Bool {
    observer.calls.contains { !$0.hasEnded }
  }
}
