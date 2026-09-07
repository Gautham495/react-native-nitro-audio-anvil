import type { RecorderConfig } from './RecorderConfig';

/**
 * Text shown in the Android foreground-service notification while recording.
 * Ignored on iOS.
 *
 * @see {@linkcode RecorderConfig.notification}
 */
export interface NotificationConfig {
  /**
   * Notification title, e.g. "Recording meeting".
   */
  title: string;
  /**
   * Notification body, e.g. "Tap to return to the app".
   */
  text: string;
}
