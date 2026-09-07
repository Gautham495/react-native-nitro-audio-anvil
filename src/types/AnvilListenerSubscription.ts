import type { AnvilRecorder } from '../specs/AnvilRecorder.nitro';

/**
 * Handle returned by every `add…Listener` method on {@linkcode AnvilRecorder}.
 * Call {@linkcode AnvilListenerSubscription.remove} to stop receiving events.
 */
export interface AnvilListenerSubscription {
  /**
   * Removes the listener owned by this subscription. Safe to call more than once.
   */
  remove: () => void;
}
