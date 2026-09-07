import type { InterruptionPolicy } from './InterruptionPolicy';
import type { NotificationConfig } from './NotificationConfig';
import type { AnvilFactory } from '../specs/AnvilFactory.nitro';

/**
 * Configuration for one recorder. Audio is always mono 16-bit PCM written as WAV.
 *
 * @see {@linkcode AnvilFactory.createRecorder}
 */
export interface RecorderConfig {
  /**
   * Absolute directory path (or `file://` URL) where segment WAV files are written.
   * Created if it does not exist.
   */
  outputDirectory: string;
  /**
   * Target length of one segment file in milliseconds. A new file is opened when this is reached.
   * 30000 is a good default. A crash can lose at most `fsyncIntervalMs` of audio, never a whole segment.
   */
  segmentDurationMs: number;
  /**
   * How often the open segment is flushed to disk with the WAV header patched (`fsync`).
   * 500 is a good default. This is the maximum audio lost on process death or power loss.
   */
  fsyncIntervalMs: number;
  /**
   * Sample rate of the written files and of both streams. 16000 is recommended
   * (most streaming speech-to-text services and speaker-embedding models expect 16 kHz). Native input is resampled if needed.
   */
  sampleRate: number;
  /**
   * Size of each chunk delivered to the PCM stream listener in milliseconds. 100 is a good default.
   */
  streamChunkMs: number;
  /**
   * Length of each speaker window in milliseconds. 1500 is a good default for speaker embeddings.
   */
  speakerWindowMs: number;
  /**
   * Hop between consecutive speaker windows in milliseconds. Must be `<= speakerWindowMs`.
   * 750 gives 50% overlap.
   */
  speakerWindowHopMs: number;
  /**
   * Behaviour when an OS interruption ends.
   */
  onInterruption: InterruptionPolicy;
  /**
   * Keep recording while the app is in the background. On Android this starts a
   * microphone foreground service; on iOS the app must declare the `audio` background mode.
   */
  keepAwakeInBackground: boolean;
  /**
   * Emit a storage warning when free space in `outputDirectory`'s volume drops below this many bytes.
   */
  storageWarningBytes: number;
  /**
   * Android foreground-service notification. Required when `keepAwakeInBackground` is `true` on Android.
   */
  notification?: NotificationConfig;
}
