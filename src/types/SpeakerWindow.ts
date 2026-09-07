import type { AnvilRecorder } from '../specs/AnvilRecorder.nitro';

/**
 * A fixed-length PCM window for speaker embedding. Mono, 16-bit little-endian PCM
 * at the configured sample rate.
 *
 * @see {@linkcode AnvilRecorder.addSpeakerWindowListener}
 */
export interface SpeakerWindow {
  buffer: ArrayBuffer;
  /**
   * Start on the recording timeline (media time) in milliseconds.
   */
  startMs: number;
  endMs: number;
  /**
   * Root-mean-square level normalized to 0…1. Skip windows near 0 — they are silence.
   */
  rms: number;
}
