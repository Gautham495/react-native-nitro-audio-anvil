import {
  Anvil,
  type AnvilListenerSubscription,
  type AnvilRecorder,
  type PendingUpload,
  type RecordingSegment,
} from 'react-native-nitro-audio-anvil';

import { putHlsFile } from './uploaderBridge';
import { OUTPUT_DIRECTORY } from './recorderService';

export interface HlsSyncEvent {
  kind: 'segment' | 'manifest';
  filename: string;
  url?: string;
  error?: string;
}

/**
 * Wires an active recorder's `addSegmentCompletedListener` and
 * `addManifestUpdatedListener` to bucket PUTs. Sequential per recording — HLS players
 * only see a segment if the manifest referencing it also lands, so we PUT the segment
 * first, then the manifest. If a segment fails, we skip its manifest PUT for that
 * cycle; the next successful segment brings a fresh manifest along with it.
 *
 * On segment success we call `markSegmentUploaded` — the sentinel makes
 * `retryPendingUploads` skip it on next launch.
 */
export function attachHlsSync(
  recorder: AnvilRecorder,
  onEvent: (event: HlsSyncEvent) => void
): () => void {
  const recordingId = recorder.recordingId;
  const queue: Array<() => Promise<void>> = [];
  let draining = false;
  let stopped = false;

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !stopped) {
        const job = queue.shift()!;
        try {
          await job();
        } catch (error) {
          // Swallow — sentinel isn't written, retry will pick it up on next launch.
          onEvent({
            kind: 'segment',
            filename: '?',
            error: String(error),
          });
        }
      }
    } finally {
      draining = false;
    }
  };

  const enqueue = (job: () => Promise<void>) => {
    queue.push(job);
    void drain();
  };

  const segmentSub: AnvilListenerSubscription = recorder.addSegmentCompletedListener(
    (segment: RecordingSegment) => {
      enqueue(async () => {
        try {
          const { url } = await putHlsFile({
            recordingId,
            filename: segment.filename,
            filePath: segment.filePath,
          });
          await recorder.markSegmentUploaded(segment.filename);
          onEvent({ kind: 'segment', filename: segment.filename, url });
        } catch (error) {
          onEvent({
            kind: 'segment',
            filename: segment.filename,
            error: String(error),
          });
        }
      });
    }
  );

  const manifestSub: AnvilListenerSubscription = recorder.addManifestUpdatedListener(
    (manifestPath: string) => {
      enqueue(async () => {
        try {
          const { url } = await putHlsFile({
            recordingId,
            filename: 'manifest.m3u8',
            filePath: manifestPath,
          });
          onEvent({ kind: 'manifest', filename: 'manifest.m3u8', url });
        } catch (error) {
          onEvent({
            kind: 'manifest',
            filename: 'manifest.m3u8',
            error: String(error),
          });
        }
      });
    }
  );

  return () => {
    stopped = true;
    segmentSub.remove();
    manifestSub.remove();
  };
}

/**
 * On launch, PUT every file left un-uploaded from previous runs. Fire-and-forget the
 * manifest entries (they'll be re-put on the next successful segment anyway); for
 * segments, mark the sentinel on success.
 */
export async function drainPendingUploads(
  onEvent: (event: HlsSyncEvent) => void
): Promise<void> {
  const pending: PendingUpload[] = await Anvil.retryPendingUploads(
    OUTPUT_DIRECTORY
  );
  for (const item of pending) {
    try {
      const { url } = await putHlsFile({
        recordingId: item.recordingId,
        filename: item.filename,
        filePath: item.filePath,
      });
      if (item.kind === 'segment') {
        await Anvil.markSegmentUploaded(
          OUTPUT_DIRECTORY,
          item.recordingId,
          item.filename
        );
      }
      onEvent({ kind: item.kind, filename: item.filename, url });
    } catch (error) {
      onEvent({
        kind: item.kind,
        filename: item.filename,
        error: String(error),
      });
    }
  }
}
