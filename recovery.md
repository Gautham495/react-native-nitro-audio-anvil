# Floating UI + crash recovery

Anvil 2.0 writes each recording as a self-contained **folder** under `outputDirectory`, named by a `recordingId` you own:

```
recordings/
  <recordingId>/
    manifest.m3u8          # HLS playlist, sealed with #EXT-X-ENDLIST on stop()
    00000.aac              # ADTS AAC-LC segments, playable individually
    00001.aac
    00002.aac
    00001.aac.uploaded     # optional: sync-agent sentinels
    manifest.m3u8.uploaded
```

Two things that make recovery cheap fall out of that layout:

1. **Every segment is a valid, playable file the moment `fsync` returns.** There is no container to finalize, no header index to patch — an ADTS AAC frame is self-describing. A process disappearing mid-write costs you at most half a second of audio in the tail segment.
2. **The manifest is the ground truth for what belongs to this recording**, and it is rewritten (via tmp + rename + directory `fsync`) after every segment. On next launch you re-read the manifest, verify each `.aac` it references still exists, and pick up exactly where you left off.

The rest of this document is the pattern for the floating pill / mini-player, and the recipe for stitching across a crash boundary.

## Floating UI

`AnvilRecorder` is a native object, not React state — it survives navigation, unmounts and screen changes. Hoist it into a service module and any component can subscribe.

```ts
// services/recorder.ts
import ReactNativeBlobUtil from 'react-native-blob-util';
import {
  Anvil,
  type AnvilRecorder,
  type RecordingSegment,
} from 'react-native-nitro-audio-anvil';

const fs = ReactNativeBlobUtil.fs;
export const OUTPUT_DIRECTORY = `${fs.dirs.DocumentDir}/recordings`;

export async function ensureOutputDirectory() {
  if (!(await fs.exists(OUTPUT_DIRECTORY))) {
    await fs.mkdir(OUTPUT_DIRECTORY);
  }
}

export function makeRecordingId() {
  // Anything you want — meeting id, call id, uuid. Must be a single path
  // segment (no slashes, no ".."). See Anvil's validator.
  return `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

class RecorderService {
  active: AnvilRecorder | null = null;

  async begin(input: {
    recordingId: string;
    config: Omit<Parameters<typeof Anvil.createRecorder>[0], 'outputDirectory' | 'recordingId'>;
  }): Promise<AnvilRecorder> {
    if (this.active) throw new Error('Recorder already active');
    const recorder = await Anvil.createRecorder({
      outputDirectory: OUTPUT_DIRECTORY,
      recordingId: input.recordingId,
      ...input.config,
    });
    await recorder.start();
    this.active = recorder;
    return recorder;
  }

  async end(): Promise<RecordingSegment[]> {
    const recorder = this.active;
    if (!recorder) return [];
    const segments = await recorder.stop(); // seals manifest.m3u8
    this.active = null;
    return segments;
  }

  async recoverPending() {
    return await Anvil.discoverOrphanedRecordings(OUTPUT_DIRECTORY);
  }

  async concatenate(recordingId: string, outputPath: string) {
    return await Anvil.concatenate(OUTPUT_DIRECTORY, recordingId, outputPath);
  }

  async deleteRecording(recordingId: string) {
    return await Anvil.deleteRecording(OUTPUT_DIRECTORY, recordingId);
  }
}

export const recorderService = new RecorderService();
```

Then from your floating pill, mini-player or any screen:

```ts
import { recorderService, makeRecordingId, OUTPUT_DIRECTORY } from '@/services/recorder';

// Start (from the "record" button on any screen)
const recordingId = makeRecordingId();
await recorderService.begin({
  recordingId,
  config: {
    segmentDurationMs: 6000,
    fsyncIntervalMs: 500,
    sampleRate: 48000,
    aacBitrate: 96000,
    streamChunkMs: 100,
    speakerWindowMs: 1500,
    speakerWindowHopMs: 750,
    onInterruption: 'resume',
    keepAwakeInBackground: true,
    storageWarningBytes: 100 * 1024 * 1024,
    notification: { title: 'Recording', text: 'Anvil is capturing audio' },
  },
});

// Read state from the floating pill
const recorder = recorderService.active;
if (recorder !== null) {
  // recorder.state, recorder.totalDurationMs, recorder.recordingId
  // recorder.addPCMListener(...), recorder.addSegmentCompletedListener(...)
}

// Stop from wherever the user taps "done"
const segments = await recorderService.end();
```

The recorder keeps going across screen changes, backgrounding and navigation because it lives in the native layer, not the React tree. The floating pill polls `recorder.totalDurationMs` on an interval (or subscribes to `addSegmentCompletedListener`) to update its display.

The `recordingId` is yours to own — meeting id, call id, whatever your app already uses. Anvil validates it as a single path segment (no `/`, no `\`, no `..`, no NUL). Because the folder name matches your id, you can later find any recording by the same id you already have in your database.

## Crash recovery — the discover step

Call `Anvil.discoverOrphanedRecordings(dir)` once at app start, before any UI touches the recorder. It scans `outputDirectory`, reads each recording's `manifest.m3u8`, verifies every referenced `.aac` still exists and parses as valid ADTS, and returns one entry per folder that never got sealed (`#EXT-X-ENDLIST` missing).

```ts
// App.tsx
import { useEffect, useState } from 'react';
import {
  Anvil,
  type RecoveredRecording,
} from 'react-native-nitro-audio-anvil';
import { OUTPUT_DIRECTORY, recorderService } from '@/services/recorder';

const [orphans, setOrphans] = useState<RecoveredRecording[]>([]);

useEffect(() => {
  (async () => {
    const found = await Anvil.discoverOrphanedRecordings(OUTPUT_DIRECTORY);
    setOrphans(found);
  })().catch((err) => console.log('recovery failed', err));
}, []);
```

Each `RecoveredRecording` gives you everything you need to make the product decision:

```ts
type RecoveredRecording = {
  recordingId: string;         // the folder name — the same id you passed to begin()
  folderPath: string;          // absolute path to the recording folder
  manifestPath: string;        // absolute path to manifest.m3u8 (verified + repaired if needed)
  segments: RecordingSegment[]; // every .aac referenced by the manifest, in order
  totalDurationMs: number;     // sum of segment durations
  wasInterrupted: boolean;     // true if the manifest was not sealed with #EXT-X-ENDLIST
};
```

### What the discover step does under the hood

Discovery is not just a directory listing. For each folder under `outputDirectory`:

1. Read `manifest.m3u8`. If missing → skip the folder (nothing to salvage).
2. Verify every `.aac` the manifest references still exists on disk. Missing files are dropped from the returned segment list.
3. For each referenced `.aac`, run an ADTS frame scan. Files that don't parse (truncated in the middle of a frame — very rare, requires a power cut mid-write with an incomplete frame in the OS page cache) are dropped.
4. Look for any unreferenced trailing `.aac` in the folder — the case where the recorder crashed after writing a segment but before rewriting the manifest. If the trailing segment parses as valid ADTS, it is added to the returned segment list and the manifest is rewritten to include it. If it doesn't parse, it is deleted.
5. If the manifest was not sealed (`#EXT-X-ENDLIST` missing), `wasInterrupted` is `true`. The manifest is left unsealed — sealing is up to whichever recovery path you choose.

The result: `segments` is a guaranteed-playable, in-order list. `manifestPath` is a valid live HLS manifest for anything that speaks HLS. Nothing has been mutated beyond salvaging trailing segments and deleting unparseable ones.

## Three recovery paths

Give the user one of three verbs per orphan. The example app wires all three:

### Resume — keep recording where it left off

Pass `resume: true` to `Anvil.createRecorder` with the same `recordingId`. The recorder re-opens the folder, walks the manifest to find the next segment index, and continues appending. Media time picks up at the end of the last segment.

```ts
async function resumeOrphan(orphan: RecoveredRecording) {
  const recorder = await Anvil.createRecorder({
    outputDirectory: OUTPUT_DIRECTORY,
    recordingId: orphan.recordingId,
    resume: true,
    ...configForThisRecording,
  });
  await recorder.start();
  // recorder.totalDurationMs is already orphan.totalDurationMs
}
```

**Constraints:** `sampleRate` and `recordingId` must match the original — resume rejects on mismatch. `aacBitrate` and `segmentDurationMs` are allowed to change; the manifest gets `#EXT-X-DISCONTINUITY` before the new segments so any HLS player knows the stream parameters change there.

**Use when:** the user was in the middle of something and wants to keep going — a meeting that dropped, a lecture that was force-quit. This is the least surprising option for the user.

### Finalize — seal what's on disk and move on

Concatenate the salvaged segments into one `.aac` file and delete the folder. This is a byte-copy of the ADTS payloads — no re-encoding, no quality loss, and takes as long as `fs` needs to read + write the total bytes (~seconds for a 90-minute recording on modern flash).

```ts
async function finalizeOrphan(orphan: RecoveredRecording) {
  const outputPath = `${OUTPUT_DIRECTORY}/${orphan.recordingId}.aac`;
  const full = await Anvil.concatenate(
    OUTPUT_DIRECTORY,
    orphan.recordingId,
    outputPath,
  );
  // full.filePath, full.fileSize, full.durationMs — the single archive file
  // Optionally: await Anvil.deleteRecording(OUTPUT_DIRECTORY, orphan.recordingId);
}
```

The output `.aac` is a plain ADTS stream — every player that reads `audio/aac` handles it (VLC, ffmpeg, browsers, Whisper's audio ingest). Server-side you can transmux to `.mp4` with `ffmpeg -c copy` (still no re-encode) if you need a different container.

**Use when:** the meeting is over and the user just wants the file — upload to your STT pipeline, keep as an archive, and forget the folder.

### Discard — throw it away

```ts
async function discardOrphan(orphan: RecoveredRecording) {
  await Anvil.deleteRecording(OUTPUT_DIRECTORY, orphan.recordingId);
}
```

Removes the folder and everything in it. The one-way-door verb — surface behind a confirmation.

**Use when:** the user tapped record by accident, or the recording is truly unrecoverable garbage (silence, wrong device), or they just want the disk space back.

## HLS sync recovery — the second retry queue

If you were streaming segments to R2 (or any object store) via a per-file sync agent, the sync side has its own recovery path independent of the recorder. Anvil records which files a sync agent successfully pushed by writing `<filename>.uploaded` sentinels next to the segment. On next launch, call `Anvil.retryPendingUploads(outputDirectory)` to get back the files that were written locally but never confirmed uploaded:

```ts
import { Anvil, type PendingUpload } from 'react-native-nitro-audio-anvil';

const pending: PendingUpload[] = await Anvil.retryPendingUploads(OUTPUT_DIRECTORY);
// [{ recordingId, filePath, filename, kind: 'segment' | 'manifest' }, ...]

for (const p of pending) {
  await putHlsFile(p.recordingId, p.filename, p.filePath);
  await Anvil.markSegmentUploaded(p.filePath);
}
```

This is entirely separate from `discoverOrphanedRecordings`. A recording can be fully sealed locally (no orphan) but still have unshipped segments (leftover pending uploads) — pending an app crash between a segment landing on disk and the sync agent PUTting it. Run both on launch.

## Guarantees

| Failure between `start()` and `stop()`             | Recovered?                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Force quit                                         | ✅ — every sealed segment plus the salvaged tail; worst case ~500 ms lost           |
| App crash                                          | ✅                                                                                  |
| OS memory-pressure kill                            | ✅                                                                                  |
| Battery dies                                       | ✅                                                                                  |
| Device reboot                                      | ✅                                                                                  |
| Trailing segment written but manifest not rewritten | ✅ — discover walks the folder, salvages parseable trailing AAC, rewrites manifest |
| Trailing segment truncated mid-frame               | ✅ — the trailing segment is dropped; everything before it stays                    |
| User taps "record" again before recovery ran      | ⚠️ starts a NEW recording under a new folder; the crashed one still recovers later   |
| Upload never happened for some segments            | ✅ — `retryPendingUploads` returns them for the sync agent to re-attempt            |
| User deletes app                                   | ❌ — files were in the app sandbox                                                  |

Every file on disk is a valid AAC/HLS artifact at every instant. There is no finalize step to skip.

## The pragmatic ship

For most apps, three UI moves cover the whole matrix:

1. **On launch, before the record button renders**: run `Anvil.discoverOrphanedRecordings` and `Anvil.retryPendingUploads`. If either returns anything, show a recovery banner or modal.
2. **In the recovery UI**, give the user three buttons per orphan — Resume, Finalize, Discard — matching the three verbs above. Discard behind a confirmation.
3. **After the modal**, if there are pending uploads left, let the sync agent chew through them silently in the background. `Anvil.markSegmentUploaded` is idempotent, so a re-run is safe.

That is the whole recovery loop. The reference implementation is [`example/src/App.tsx`](../example/src/App.tsx) and [`example/src/RecoveryCard.tsx`](../example/src/RecoveryCard.tsx).
