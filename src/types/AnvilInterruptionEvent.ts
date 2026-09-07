import type { AnvilRecorder } from '../specs/AnvilRecorder.nitro';

/**
 * Why capture was taken away from the recorder.
 *
 * - `call`: a phone/VoIP call is active
 * - `muted`: the built-in mic was muted by the system (iOS)
 * - `route`: the input device disconnected mid-capture (iOS)
 * - `reset`: the OS media server restarted (iOS `mediaServicesWereReset`)
 * - `focus`: another app took audio focus / capture was silenced (Android)
 * - `other`: any other system interruption (Siri, alarm, …)
 *
 * @see {@linkcode AnvilInterruptionEvent.reason}
 */
export type AnvilInterruptionReason =
  'call' | 'muted' | 'route' | 'reset' | 'focus' | 'other';

/**
 * Whether the interruption is starting or has finished.
 *
 * @see {@linkcode AnvilInterruptionEvent.phase}
 */
export type AnvilInterruptionPhase = 'began' | 'ended';

/**
 * Emitted by {@linkcode AnvilRecorder.addInterruptionListener}.
 * On `began`, the segment recorded so far has already been finalized on disk.
 */
export interface AnvilInterruptionEvent {
  phase: AnvilInterruptionPhase;
  reason: AnvilInterruptionReason;
  /**
   * On `ended`: the OS hint that capture may resume. With policy `resume` the recorder
   * already resumed when this is `true`. With policy `hold`, or when this is `false`,
   * call `resume()` yourself.
   */
  shouldResume: boolean;
  /**
   * Path of the segment file finalized because of this interruption, or `''` if none.
   */
  segmentPath: string;
  /**
   * Position on the recording timeline (media time) in milliseconds.
   */
  timestampMs: number;
}
