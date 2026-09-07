import type { AnvilRecorder } from '../specs/AnvilRecorder.nitro';

/**
 * Lifecycle state of an {@linkcode AnvilRecorder}.
 *
 * - `idle`: created, `start()` not called yet
 * - `recording`: capturing and writing to disk
 * - `paused`: paused by the app via `pause()`
 * - `interrupted`: capture was taken away by the OS (call, Siri, focus loss…). The segment recorded so far is already finalized on disk.
 * - `stopped`: `stop()` was called; the recorder cannot be started again
 *
 * @see {@linkcode AnvilRecorder.state}
 */
export type RecorderState =
  'idle' | 'recording' | 'paused' | 'interrupted' | 'stopped';
