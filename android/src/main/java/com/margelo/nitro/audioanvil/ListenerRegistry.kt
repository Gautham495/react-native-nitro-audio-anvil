package com.margelo.nitro.audioanvil

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong

/** Lock-free listener store: add/remove from the JS thread, emit from the audio thread. */
internal class ListenerRegistry<Event> {
  private val listeners = CopyOnWriteArrayList<Pair<Long, (Event) -> Unit>>()
  private val nextId = AtomicLong(0)

  fun add(listener: (Event) -> Unit): Long {
    val id = nextId.incrementAndGet()
    listeners.add(Pair(id, listener))
    return id
  }

  fun remove(id: Long) {
    listeners.removeAll { it.first == id }
  }

  fun emit(event: Event) {
    for (entry in listeners) {
      entry.second(event)
    }
  }
}
