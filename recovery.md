# Floating UI + crash recovery

## Floating UI

`AnvilRecorder` is a native object, not React state — it survives navigation, unmounts and screen changes. Hoist it into a service module and any component can subscribe.

```ts
// services/recorder.ts
import ReactNativeBlobUtil from 'react-native-blob-util';
import {
  createFileMarkerStore,
  createRecordingService,
  type FileSystemBridge,
} from 'react-native-nitro-audio-anvil';

const fs = ReactNativeBlobUtil.fs;
export const OUTPUT_DIRECTORY = `${fs.dirs.DocumentDir}/recordings`;

const fileSystemBridge: FileSystemBridge = {
  async readText(path) {
    try {
      return await fs.readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  async writeText(path, contents) {
    await fs.writeFile(path, contents, 'utf8');
  },
  async delete(path) {
    if (await fs.exists(path)) await fs.unlink(path);
  },
  async list(directory) {
    try {
      const names = await fs.ls(directory);
      return names.map((name) => `${directory}/${name}`);
    } catch {
      return [];
    }
  },
};

export const recorderService = createRecordingService({
  outputDirectory: OUTPUT_DIRECTORY,
  markerStore: createFileMarkerStore(fileSystemBridge, OUTPUT_DIRECTORY),
});
```

Then from your floating pill, mini-player or any screen:

```ts
import { recorderService } from '@/services/recorder';

// Start (from the "record" button on any screen)
await recorderService.begin({
  logicalId: meetingId,
  config: {
    outputDirectory: OUTPUT_DIRECTORY,
    segmentDurationMs: 30_000 /* ... */,
  },
});

// Read state from the floating pill
const recorder = recorderService.active;
if (recorder !== null) {
  // recorder.state, recorder.totalDurationMs, recorder.addPCMListener(...)
}

// Stop from wherever the user taps "done"
const segments = await recorderService.end();
```

The recorder keeps recording across screen changes, backgrounding and navigation — because it lives in the native layer, not the React tree. The floating pill just reads `recorder.totalDurationMs` on an interval (or subscribes to a listener) to update its display.

## Crash recovery — stitching on relaunch

Call `recoverPendingRecordings` once at app start, before any UI renders. It groups every orphaned Anvil session by the `logicalId` you gave to `begin()` and calls back once per logical recording.

```ts
// App.tsx
import { recorderService } from '@/services/recorder';
import { uploader } from '@/services/uploader';

useEffect(() => {
  recorderService
    .recoverPendingRecordings(async (recording) => {
      // `recording.segments` is every WAV file from every session that belonged to this meeting,
      // already in playback order across the crash boundary.
      // `recording.logicalId` is your own id (meetingId, callId, sessionId…).
      await uploader.uploadStitched({
        meetingId: recording.logicalId,
        segments: recording.segments,
        totalDurationMs: recording.totalDurationMs,
      });
    })
    .catch((err) => log.error('recovery failed', err));
}, []);
```

### What "stitched" means

Each Anvil session numbers its media time from zero, so segment #0 of session A and segment #0 of session B both start at `mediaStartMs: 0`. The recovery layer sorts by wall-clock `startedAt` so `recording.segments` is already in the right order for concatenation.

You have two options for producing one file:

**On device** — `Anvil.concatenate(paths, outputPath)` streams the PCM of each segment into one WAV and returns its metadata. Instant, no re-encoding, everything stays local.

```ts
const full = await Anvil.concatenate(
  recording.segments.map((s) => s.filePath),
  `${OUTPUT_DIRECTORY}/${recording.logicalId}-full.wav`
);
```

**Server-side** with ffmpeg — same shape, useful when the server already has the segments:

```sh
ffmpeg -f concat -safe 0 -i list.txt -c copy meeting.wav
# list.txt: file '/path/to/session-a-00000.wav' \n file '/path/to/session-a-00001.wav' \n file '/path/to/session-b-00000.wav'
```

Because every file is mono 16-bit PCM at the same sample rate, `-c copy` is instant — no re-encoding, no quality loss.

### Guarantees

| Failure between `begin()` and `end()`        | Recovered?                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| Force quit                                   | ✅ — segments up to last fsync (worst case: 500 ms lost per session boundary) |
| App crash                                    | ✅                                                                            |
| OS memory-pressure kill                      | ✅                                                                            |
| Battery dies                                 | ✅                                                                            |
| Device reboot                                | ✅                                                                            |
| User taps "record" again before recovery ran | ⚠️ starts a NEW session; the crashed one still recovers on the next launch    |
| User deletes app                             | ❌ — files were in app sandbox                                                |

### Resume vs upload-and-discard

`recoverPendingRecordings` gives you the segments. What you do with them is a product decision:

- **Upload + treat as complete** (simplest, recommended): the meeting ended when the app crashed. Upload what you have, mark the meeting as done. User sees the meeting with a slightly shorter transcript.
- **Upload + resume**: after uploading, immediately call `begin({ logicalId: sameMeetingId, ... })` to start a new session tied to the same meeting. On the next `end()`, upload the new segments. Server concatenates all of them. User keeps recording where they left off — mostly invisible except for a ~1 s gap in the audio around the crash.
- **Ask the user**: show a modal, let them choose.

Start with option 1 and add option 2 once the base loop is boring.
