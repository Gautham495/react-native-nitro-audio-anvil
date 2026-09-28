import type { AnvilFactory } from '../specs/AnvilFactory.nitro';
import type { NotificationConfig } from './NotificationConfig';
import type { InterruptionPolicy } from './InterruptionPolicy';

/**
 * Configuration for one recorder. Audio is captured as mono 16-bit PCM and encoded to
 * ADTS AAC for the on-disk segments; the live PCM and speaker-window streams stay raw PCM
 * at `sampleRate`.
 *
 * The recorder writes to `${outputDirectory}/${recordingId}/`. The folder is the recording;
 * everything Anvil knows about a recording lives inside it. There is no sidecar state
 * elsewhere.
 *
 * @see {@linkcode AnvilFactory.createRecorder}
 */
export interface RecorderConfig {
  /**
   * Absolute directory path (or `file://` URL) that HOLDS every recording folder.
   * Anvil creates `${outputDirectory}/${recordingId}/` on first segment write.
   * The parent directory is created if it does not exist; the recording folder itself
   * is created lazily so a rejected `createRecorder` leaves nothing behind.
   */
  outputDirectory: string;
  /**
   * The recording's id. Chosen by the caller — Anvil never generates one. Becomes the
   * folder name under `outputDirectory` and is echoed on the recorder as `recordingId`.
   * Must be a valid single-segment path component (no `/`, no `\`, no `..`).
   */
  recordingId: string;
  /**
   * Opt into resuming an existing folder. When `true`, Anvil expects an unsealed
   * `manifest.m3u8` at `${outputDirectory}/${recordingId}/manifest.m3u8`, reads the last
   * segment index from it, and starts capturing at `max + 1`. A `#EXT-X-DISCONTINUITY`
   * is inserted before the first new segment.
   *
   * `createRecorder` rejects when this is `false` (or absent) and the folder already
   * contains a manifest, and when it is `true` but the manifest is sealed
   * (`#EXT-X-ENDLIST` present) or missing.
   *
   * `sampleRate` must match the existing manifest's rate; `aacBitrate` and
   * `segmentDurationMs` may differ (bitrate is handled by the discontinuity; a larger
   * `segmentDurationMs` bumps `#EXT-X-TARGETDURATION`).
   *
   * Defaults to `false`.
   */
  resume?: boolean;

  /**
   * Target length of one segment file in milliseconds. A new segment is opened when this
   * is reached (on the next ADTS-frame boundary — frames are 1024 samples ≈ 64 ms at 16 kHz).
   * 6000 is a good live-streaming default. 30000 favors archival with fewer files.
   */
  segmentDurationMs: number;
  /**
   * How often the open segment is fsynced (`F_FULLFSYNC` on iOS, `FileDescriptor.sync` on
   * Android). 500 is a good default. This is the maximum audio lost on process death or
   * power loss.
   */
  fsyncIntervalMs: number;
  /**
   * Sample rate of the captured audio, the AAC segments and the live streams. 16000 is
   * recommended for speech; 8000/16000/22050/24000/32000/44100/48000 are supported.
   * The native input is resampled to this rate before encoding.
   */
  sampleRate: number;
  /**
   * AAC encode bitrate in bits per second. 64000 is a good default for mono speech at
   * 16 kHz. Higher values increase file size and offer diminishing returns above 96 kbps
   * for voice content.
   */
  aacBitrate: number;

  /**
   * Size of each chunk delivered to the PCM stream listener in milliseconds. 100 is a
   * good default for streaming speech-to-text sockets.
   */
  streamChunkMs: number;
  /**
   * Length of each speaker window in milliseconds. 1500 is a good default for speaker
   * embedding models.
   */
  speakerWindowMs: number;
  /**
   * Hop between consecutive speaker windows in milliseconds. Must be `<= speakerWindowMs`.
   * 750 gives 50 % overlap.
   */
  speakerWindowHopMs: number;

  /**
   * Behaviour when an OS interruption ends and the OS says capture may resume.
   */
  onInterruption: InterruptionPolicy;
  /**
   * Keep recording while the app is in the background. On Android this starts a
   * `microphone` foreground service; on iOS the app must declare the `audio` background
   * mode.
   */
  keepAwakeInBackground: boolean;
  /**
   * Emit a storage warning when free space on `outputDirectory`'s volume drops below
   * this many bytes. Checked at start and after every segment rotation.
   */
  storageWarningBytes: number;
  /**
   * Android foreground-service notification. Required when `keepAwakeInBackground` is
   * `true` on Android. Ignored on iOS.
   */
  notification?: NotificationConfig;
}
