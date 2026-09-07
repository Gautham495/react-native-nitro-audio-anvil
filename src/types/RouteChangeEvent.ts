import type { AnvilRecorder } from '../specs/AnvilRecorder.nitro';

/**
 * Why the audio input route changed.
 *
 * @see {@linkcode RouteChangeEvent.reason}
 */
export type RouteChangeReason =
  'connected' | 'disconnected' | 'category' | 'forced' | 'wake' | 'unknown';

/**
 * Emitted by {@linkcode AnvilRecorder.addRouteChangeListener} when the input device changes
 * (AirPods connected, headset unplugged, …). When the input actually changed while recording,
 * the current segment is rotated so no file mixes two devices.
 */
export interface RouteChangeEvent {
  reason: RouteChangeReason;
  /**
   * Human-readable name of the input now in use, e.g. "iPhone Microphone", "AirPods Pro".
   */
  inputName: string;
  /**
   * `true` when the active input device changed and the segment was rotated.
   */
  inputChanged: boolean;
  /**
   * Position on the recording timeline (media time) in milliseconds.
   */
  timestampMs: number;
}
