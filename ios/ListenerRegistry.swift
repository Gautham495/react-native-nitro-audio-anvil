import Foundation

/// Listener store owned by one serial queue. Not thread-safe by design:
/// every call must happen on the owner's queue.
final class ListenerRegistry<Event> {
  private var listeners: [UUID: (Event) -> Void] = [:]

  func add(_ id: UUID, _ listener: @escaping (Event) -> Void) {
    listeners[id] = listener
  }

  func remove(_ id: UUID) {
    listeners.removeValue(forKey: id)
  }

  func emit(_ event: Event) {
    let snapshot = Array(listeners.values)
    for listener in snapshot {
      listener(event)
    }
  }
}
