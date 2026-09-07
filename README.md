<a href="https://gauthamvijay.com">
  <picture>
    <img alt="react-native-nitro-audio-anvil" src="./docs/img/banner.png" />
  </picture>
</a>

# react-native-nitro-audio-anvil

Corruption-proof microphone recording for React Native, built on [Nitro Modules](https://nitro.margelo.com).

- **PCM straight to disk.** Mono 16-bit WAV. No encoder, nothing to finalize.
- **Valid at every instant.** The WAV header is patched and the file is `fsync`ed every `fsyncIntervalMs`. A crash, force-quit, SIGKILL, phone call or dead battery loses at most `fsyncIntervalMs` of audio — never a file.
- **Segmented.** A new file every `segmentDurationMs`. Rotated on pause, interruption and input-device change too, so no file mixes two devices.
- **Interruptions handled natively.** Calls, Siri, alarms, media-server reset (iOS), audio focus / capture silenced (Android): the open segment is finalized _before_ the OS takes the mic, and you get an event.
- **Two live streams from one capture.** `PCMChunk`s for streaming speech-to-text, overlapping `SpeakerWindow`s for speaker labelling / diarization.
- **Recovery built in.** `extractRange()` re-reads any media-time range from disk (socket dropped? resend it). `discoverOrphanedRecordings()` repairs and returns sessions from a previous crashed launch.

No VAD, no upload, no transcription, no embedding. Those live in your app.

## Install

```sh
yarn add react-native-nitro-audio-anvil react-native-nitro-modules
cd ios && pod install
```

---

## 🎥 Demo

<table>
  <tr>
    <th align="center">🍏 iOS Demo</th>
    <th align="center">🤖 Android Demo</th>
  </tr>
  <tr>
    <td align="center">
    <img src="./docs/videos/iOS.gif" width="300" alt="Demo GIF" />
    </td>
     <td align="center">
    <img src="./docs/videos/android.gif" width="300" alt="Demo GIF" />
    </td>
  </tr>
</table>

### iOS

`Info.plist`:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Records your meetings</string>
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
```

### Android

Permissions and the microphone foreground service are declared in the library manifest and merged automatically. Request `POST_NOTIFICATIONS` at runtime on Android 13+ if you want the foreground notification to be visible. `keepAwakeInBackground: true` requires `notification` in the config and must be started while the app is in the foreground (Android 14+ rule).

## Usage

```ts
import { Anvil, type AnvilRecorder } from 'react-native-nitro-audio-anvil';

if ((await Anvil.requestPermission()) !== 'granted') return;

const recorder: AnvilRecorder = await Anvil.createRecorder({
  outputDirectory: `${documentDirectory}meetings`, // plain path or file:// URL
  segmentDurationMs: 30_000,
  fsyncIntervalMs: 500,
  sampleRate: 16000,
  streamChunkMs: 100,
  speakerWindowMs: 1500,
  speakerWindowHopMs: 750,
  onInterruption: 'resume',
  keepAwakeInBackground: true,
  storageWarningBytes: 200 * 1024 * 1024,
  notification: { title: 'Recording meeting', text: 'Tap to return' },
});

// Stream 1 → your streaming speech-to-text socket (pcm16, 16 kHz, mono — send the buffer as-is)
const pcm = recorder.addPCMListener((chunk) => {
  socket.send(chunk.buffer);
});

// Stream 2 → your speaker-embedding model → label who is talking
const speaker = recorder.addSpeakerWindowListener(async (window) => {
  if (window.rms < 0.01) return; // silence
  const label = await labelSpeaker(window.buffer, window.startMs, window.endMs);
  emitter.emit('speaker-label', {
    startMs: window.startMs,
    endMs: window.endMs,
    label,
  });
});

recorder.addInterruptionListener((e) => {
  // e.phase === 'began': e.segmentPath is already a valid file on disk
  // e.phase === 'ended' && !e.shouldResume: call recorder.resume() when you want
});
recorder.addSegmentCompletedListener((segment) => uploader.enqueue(segment));
recorder.addErrorListener((error) => log.error(error.code, error.message));

await recorder.start();
// ...
const segments = await recorder.stop();

pcm.remove();
speaker.remove();
```

### Recovering a gap in the stream

```ts
// Streaming socket dropped from media time 120000 to 135000 ms
const path = await recorder.extractRange(120_000, 135_000);
await transcribeFile(path); // your batch transcription endpoint
```

### After a crash

```ts
const orphaned = await Anvil.discoverOrphanedRecordings(meetingsDir);
for (const session of orphaned) uploader.enqueueAll(session.segments);
```

Headers are repaired and markers cleared before the sessions are returned; the WAV files stay on disk for you. For grouping sessions back into your own ids across a crash, see `docs/recovery.md`.

## Timeline

All timestamps (`PCMChunk.timestampMs`, `SpeakerWindow.startMs`, `RecordingSegment.mediaStartMs`, `extractRange`) are **media time**: milliseconds of captured audio, which only advance while capturing. That is exactly the timeline a streaming transcription service sees, so joining transcript segments with speaker labels is a plain interval overlap.

## Events

| Listener                      | When                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `addPCMListener`              | every `streamChunkMs` while recording                                            |
| `addSpeakerWindowListener`    | every `speakerWindowHopMs` once a full window exists                             |
| `addInterruptionListener`     | OS took / returned the mic (`call`, `muted`, `route`, `reset`, `focus`, `other`) |
| `addRouteChangeListener`      | input device changed; segment rotated when the active input changed              |
| `addPermissionChangeListener` | mic permission differs from last check (checked on every start/resume)           |
| `addStorageWarningListener`   | free space below `storageWarningBytes` (checked at start and every rotation)     |
| `addSegmentCompletedListener` | a WAV file was finalized, with `sha256`                                          |
| `addErrorListener`            | pipeline failure; recorder moves to `interrupted`, data on disk is safe          |

`RecorderState`: `idle → recording ⇄ paused / interrupted → stopped`. `stop()` always resolves with every segment.

## Building the library

```sh
yarn install
yarn nitrogen        # generates nitrogen/generated from src/specs/*.nitro.ts
yarn typecheck
```

`nitrogen/generated/` must be committed and shipped in the npm package.

### First build checklist

The native code is written against Nitrogen's naming conventions but was authored without running codegen. After the first `yarn nitrogen`, open `nitrogen/generated/ios/swift/HybridAnvilRecorderSpec.swift` and `nitrogen/generated/android/kotlin/.../HybridAnvilRecorderSpec.kt` and confirm:

1. Method signatures match (`throws`, `Promise<Void>` vs `Promise<Unit>`, parameter labels).
2. Enum case names: `RecorderState.idle` / `RecorderState.IDLE`, `InterruptionReason.call` / `CALL`, etc.
3. `ListenerSubscription(remove:)` — if Kotlin generates a `Func_void` wrapper instead of a lambda, wrap the lambda accordingly.
4. `createRecorder` return type in Swift (`Promise<any HybridAnvilRecorderSpec>`).

`android/build.gradle`, `android/CMakeLists.txt`, `android/src/main/cpp/cpp-adapter.cpp` and `NitroAudioAnvil.podspec` follow the Nitro template; if `npx nitrogen@latest init` emits newer versions of these files, they are drop-in replacements.

## How the guarantee works

1. Every write appends raw PCM after a WAV header.
2. Every `fsyncIntervalMs`: patch the RIFF/data size fields, then `fsync`. Header and data are consistent on disk at each of these points.
3. On interruption `began`: the segment is finalized (patched, synced, hashed) before the recorder reports it.
4. On process death: whatever was synced is a valid WAV. `discoverOrphanedRecordings` also repairs the header from the real file length, recovering audio written after the last patch.

There is no moov atom, no encoder state, no finalize step to skip.

## License

MIT
