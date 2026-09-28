# Troubleshooting

**How to diagnose recording problems, in order of frequency.** Every entry has a symptom the user or developer sees, a hypothesis for what is actually happening underneath, and either a fix or a way to prove or disprove the hypothesis.

If you have not read the [interruption handling section](../README.md#-interruption-handling-in-detail) of the README or the [OEM quirks doc](./oem-quirks.md), do those first. Most support tickets fall in one of those two buckets.

---

## Contents

1. [Recording stops when I lock my phone](#recording-stops-when-i-lock-my-phone)
2. [After a phone call, recording does not auto-resume](#after-a-phone-call-recording-does-not-auto-resume)
3. [After WhatsApp / Voice Memos / Siri, recording does not auto-resume](#after-whatsapp--voice-memos--siri-recording-does-not-auto-resume)
4. [iOS: "AudioCodecInitialize failed" or "kAudio\_ParamError"](#ios-audiocodecinitialize-failed-or-kaudio_paramerror)
5. [Voice sounds robotic, metallic or chipmunky](#voice-sounds-robotic-metallic-or-chipmunky)
6. [The recording folder is empty or the manifest is missing](#the-recording-folder-is-empty-or-the-manifest-is-missing)
7. [A segment file won't play in a player or transcoder](#a-segment-file-wont-play-in-a-player-or-transcoder)
8. [Recording started but produces only silence](#recording-started-but-produces-only-silence)
9. [Segments are much shorter than expected](#segments-are-much-shorter-than-expected)
10. [HLS stream never appears in the player](#hls-stream-never-appears-in-the-player)
11. [I keep getting "Auto-resume deferred" — is that a bug?](#i-keep-getting-auto-resume-deferred--is-that-a-bug)
12. [The example app works but my integration doesn't](#the-example-app-works-but-my-integration-doesnt)
13. [Emulator vs real device — what actually works where](#emulator-vs-real-device--what-actually-works-where)
14. [How to get useful logs to share](#how-to-get-useful-logs-to-share)

---

## Recording stops when I lock my phone

**Symptom**: The recording is going, the user locks their phone, they unlock 5–10 minutes later, and the recording has ended.

**Most common cause on Android**: Your foreground service is running but the OEM's process killer is ignoring it. This is the #1 support ticket on non-stock Android devices — Xiaomi, Huawei, Oppo, Vivo, Realme, older OnePlus.

**Diagnosis**:

1. Which brand is the phone? Check `DeviceInfo.getManufacturer()`. If it is Xiaomi/Redmi/POCO, Huawei/Honor, Oppo, Vivo/iQOO, or Realme, this is 99% an OEM issue, not a library bug.
2. Look at logcat during the lock event. If you see the foreground service notification disappear, that is the OEM killing you.

**Fix**: Point the user to the per-brand steps in [oem-quirks.md](./oem-quirks.md). No amount of native code will fix a phone that ignores foreground services.

**On iOS**: iOS handles this correctly if `UIBackgroundModes` includes `audio` in your `Info.plist`. If it does not, iOS suspends your app after 30 seconds of lock. Confirm the entitlement is present.

---

## After a phone call, recording does not auto-resume

**Symptom**: User was recording, got a phone call, hung up, and the recording did not restart.

**iOS-specific first**: iOS has a documented bug — `AVAudioSession.setActive(true)` **permanently fails** in the background after a phone-call interruption. Anvil detects this and emits `"Auto-resume deferred — bring app to foreground to continue"`. When the user returns to the app, JS should retry `resume()`.

**Verify**:

1. Check for the exact error `Auto-resume deferred` in `addErrorListener`. If present, this is the iOS bug and the fix is the AppState listener pattern in the [README interruption section](../README.md#-interruption-handling-in-detail).
2. If the error is `Auto-resume failed after N attempts`, native was in foreground but hit the retry limit. See the next section.

**Android-specific**:

1. Confirm `onInterruption: 'resume'` is set in the recorder config.
2. Confirm you are wired to `addInterruptionListener`.
3. Check logcat for `AnvilAudioFocus: focus change: 1 (GAIN)`. If you never see that message, the OS never told the app it was safe to resume — this is either an OEM quirk (see next section) or an emulator issue.

**Fix**:

- If you see `deferred` / `abandoned` errors: wire the AppState listener pattern from the README
- If you see `failed after N attempts`: the other app is still holding the mic. Increase the retry schedule or accept that the user has to tap Resume manually. Some rare devices need 8–10 seconds after the interruption ends.

---

## After WhatsApp / Voice Memos / Siri, recording does not auto-resume

**Symptom**: User sends a WhatsApp voice note or activates Siri while recording. When they come back to the app, recording is paused and does not resume automatically.

**Most likely cause**: The user was inside WhatsApp (or the other app) when the interruption "ended," so native's foreground check correctly returned `false` and the resume was deferred.

**Diagnosis**:

Ask the user: "When you finished the voice note in WhatsApp, did you close it, or did you come straight back to our app?"

- If they closed WhatsApp and then opened your app → deferred resume should fire via the AppState listener on foreground transition
- If they never left WhatsApp → the resume was deferred correctly and is waiting for foreground

**Fix**:

Wire the AppState listener from the [README](../README.md#-interruption-handling-in-detail). Without it, Anvil emits the deferred error but nothing catches it on the JS side, so recording stays paused until manual tap.

**On Android**: also check that the audio focus request in `AnvilAudioFocus` uses `AUDIOFOCUS_GAIN_TRANSIENT`, not `AUDIOFOCUS_GAIN`. The transient flag is what tells the OS "I want to come back when you're done." Without it, another app requesting `AUDIOFOCUS_GAIN` supplants your app permanently and you never get a GAIN callback.

---

## iOS: "AudioCodecInitialize failed" or "kAudio_ParamError"

**Symptom**: `Anvil.createRecorder(...)` or `recorder.start()` throws on iOS with a message from `AudioCodecInitialize` at `CodecConverter.cpp:1646`, or `kAudio_ParamError`. Reproduces on both simulator and real device.

**Cause**: The `aacBitrate` you configured is above the AAC-LC ceiling for the chosen `sampleRate`. AAC-LC has different maximum bitrates at each sample rate — 64 kbps is fine at 44.1 or 48 kHz but rejected outright at 16 kHz mono. `AVAudioConverter` returns a cryptic error instead of clamping.

**The per-sample-rate ceiling Anvil enforces** (matches AAC-LC spec):

| Sample rate | Max `aacBitrate` (mono) |
| ----------- | ----------------------- |
| 8 000 Hz    | 24 000 bps              |
| 16 000 Hz   | 48 000 bps              |
| 22 050 Hz   | 64 000 bps              |
| 24 000 Hz   | 72 000 bps              |
| 32 000 Hz   | 96 000 bps              |
| 44 100 Hz   | 192 000 bps             |
| 48 000 Hz   | 192 000 bps             |

**Fix**: Either lower `aacBitrate` for your chosen sample rate, or raise the sample rate. `48000 / 96000` is a good default for voice — mic-native rate on most iPhones (skips the resampler entirely, see next section), plenty of headroom for the encoder, small files.

`RecorderConfigValidator` throws an `AnvilError` with a readable message before the native codec is touched, so a bad config surfaces at `createRecorder(...)` rather than mid-recording.

---

## Voice sounds robotic, metallic or chipmunky

**Symptom**: Recording completes cleanly, plays back, but the voice sounds off — robotic, underwater, pitched wrong, or with a persistent buzzing artifact.

**Almost always one of three things**:

**1. Sample rate mismatch — the resampler is doing work.**  
If you configure `sampleRate: 16000` on an iPhone whose mic delivers 48 kHz natively, `AVAudioConverter` runs a real-time downsampler in the capture path. Under load or with an imperfect feeding pattern, the resampler produces artifacts.  
**Fix**: record at the mic-native rate. On modern iPhones that is 48 000 Hz. On most Android devices it is also 48 000 Hz, occasionally 44 100. If you need 16 kHz for a streaming STT service, resample downstream — after the bytes are on disk — never on the capture path.

**2. Wrong audio session mode on iOS.**  
`.measurement` mode disables software AGC and echo cancellation, and its clock behaves differently. Fine for scientific measurement, bad for meeting audio. Anvil 2.0 uses `.default` mode by default. If you patched `AnvilAudioSession` to use `.measurement`, revert it.

**3. AAC bitrate too low for the content.**  
Voice at 48 kbps mono is fine. Music, or voice + significant background noise, at 32 kbps mono starts sounding metallic. Bump `aacBitrate` up one step and retest. See the ceiling table above for the maximum you can go without hitting the codec-init error.

**Diagnosis**:

Play the raw `00000.aac` file in VLC directly (not through your app). If VLC also sounds bad, the issue is on the capture side — one of the three above. If VLC sounds fine but your player sounds bad, the issue is in your playback stack.

---

## The recording folder is empty or the manifest is missing

**Symptom**: You called `recorder.stop()` and `outputDirectory/<recordingId>/` exists but contains no files, or `manifest.m3u8` is missing.

**Almost always means the recorder never actually produced audio.** Segments only get written when the encoder has enough PCM samples to fill a segment. If you called `start()` and then `stop()` faster than `segmentDurationMs`, and nothing was captured, you get an empty folder.

**Likely causes**:

1. **Permission was revoked mid-recording**. Check `permissionChange` events. If mic permission dropped during the recording, iOS/Android silently deliver silence and no segments finalize.
2. **AudioRecord could not initialize on Android**. Check logcat for `IllegalStateException` or `AudioRecord: start() status -38`. Usually happens right after another app released the mic — the HAL is still in cleanup. Retry with backoff (Anvil already does this on native side, but if you are hitting it programmatically, wait 500–1000 ms before retrying).
3. **iOS route changed to a device with no input**. Rare, but if the recording is going to Bluetooth and the Bluetooth device disconnects during a route change, the input source can become nil for a moment.
4. **Recording lasted less than `segmentDurationMs` on `stop()`** — in that case the tail segment is finalized on stop, so the folder should still contain one small `.aac` and a sealed manifest. If the folder is truly empty, `start()` never produced anything.

**Diagnosis**:

```ts
recorder.addErrorListener((err) =>
  console.log('[anvil]', err.code, err.message)
);
recorder.addPermissionChangeListener((s) => console.log('[perm]', s));
recorder.addRouteChangeListener((r) =>
  console.log('[route]', r.reason, r.inputName)
);
recorder.addSegmentCompletedListener((s) =>
  console.log('[segment]', s.index, s.filename, s.fileSize, 'bytes')
);
```

If none of those fire and you still get an empty folder, the microphone hardware itself is not producing samples. This is a device-level issue — try recording with the built-in Voice Memos app to confirm the mic works at all.

---

## A segment file won't play in a player or transcoder

**Symptom**: A `.aac` segment exists, has non-zero size, but VLC / ffmpeg / your STT ingest rejects it or plays garbage.

**Understand what Anvil writes**: each segment is a plain **ADTS AAC-LC** stream. Every frame carries its own header describing sample rate, channel count and frame length — there is no container, no index, nothing to finalize. A player that reads `audio/aac` should handle it. If yours doesn't:

**Most likely cause 1 — the file is truncated inside a frame.**  
Very rare — requires a power cut mid-write with an incomplete frame still in the OS page cache. `Anvil.discoverOrphanedRecordings` runs an ADTS frame scan at launch and drops any file that fails to parse. If discovery hasn't run yet on this launch, the truncated file is still there.  
**Fix**: run `Anvil.discoverOrphanedRecordings(outputDirectory)` before touching any orphaned folder. It repairs manifests and drops unparseable trailing segments.

**Most likely cause 2 — the tool wants a container.**  
Some pipelines expect `.m4a`, `.mp4` or `.aac-adts` extensions specifically, or want an MP4 container even though ADTS is just as valid.  
**Fix**: transmux without re-encoding —

```sh
ffmpeg -i 00000.aac -c copy 00000.m4a
```

Instant, no quality loss. Do this on the server, not on device.

**Most likely cause 3 — bitrate ceiling issue upstream.**  
If the encoder was misconfigured (see the AudioCodecInitialize section above), individual frames may have been produced with anomalies before Anvil rejected the config. Delete and re-record.

---

## Recording started but produces only silence

**Symptom**: `state === 'recording'`, `totalDurationMs` is advancing, PCM chunks are firing, but the samples are all zero.

**Likely causes**:

1. **iOS**: `AVAudioSession` is active but the audio route has no input. This happens right after a hardware change (Bluetooth disconnected) and usually recovers in 1–2 seconds. Check `addRouteChangeListener`.
2. **Android**: `AudioRecord` is running but the microphone is muted at the hardware level. Some devices have hardware mic mute buttons (Pixel 6+ privacy toggle). Check with the built-in Voice Recorder app.
3. **Both**: The user granted permission but revoked it later, and iOS/Android returned silence instead of failing. Check `addPermissionChangeListener`.

**Diagnosis**:

Print the RMS of each PCM chunk:

```ts
recorder.addPCMListener((chunk) => {
  const samples = new Int16Array(chunk.buffer);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length) / 32768;
  console.log('rms:', rms.toFixed(4));
});
```

If RMS is always exactly 0 → the mic is muted or the route is broken. If RMS is very low but non-zero (0.001–0.01) → the mic is picking up but far from the source.

Note: PCM listener fires on the raw pre-encode buffer, so a silent PCM stream and silent encoded segments are the same problem — not two different ones.

---

## Segments are much shorter than expected

**Symptom**: You configured `segmentDurationMs: 30_000` but segments are 3 KB / 200 ms.

**Likely cause**: You are hitting interruptions constantly. Anvil finalizes the current segment on every interruption (call, focus loss, media services reset). If you are testing on an emulator with unstable audio, or on a real device with an OEM that keeps sending focus events, segments rotate.

**Diagnosis**:

```ts
recorder.addSegmentCompletedListener((s) => {
  console.log(
    'segment',
    s.index,
    'filename:',
    s.filename,
    'was_interrupted:',
    s.wasInterrupted,
    'reason:',
    s.interruptionReason,
  );
});
recorder.addInterruptionListener((e) => {
  console.log('interruption', e.phase, e.reason);
});
```

If every segment has `wasInterrupted: true`, look at `reason` for the pattern. `focus` means audio focus is being taken repeatedly (OEM quirk or another audio app running). `route` means Bluetooth is flapping.

---

## HLS stream never appears in the player

**Symptom**: Recording is running, segments are landing on disk, but the HLS URL your player points at returns 404 or the manifest is stuck at zero segments.

**This has three independent failure modes.** Rule them out in order.

**1. The sync agent is not attached.**  
Recording writes local unconditionally. Streaming to R2 (or any object store) is a separate opt-in — you attach a sync agent that listens to `addSegmentCompletedListener` and `addManifestUpdatedListener` and PUTs each file. If you never attached one, nothing is going to R2.  
**Verify**: log inside your `addSegmentCompletedListener` handler. If you see segment events but no PUT requests fire, the agent is not wired.

**2. The backend endpoint that mints presigned URLs is failing.**  
The sync agent asks your backend for a PUT URL, then PUTs the file. If the backend returns 500 or CORS blocks the presign call, no PUT ever happens.  
**Verify**: watch your backend logs for `POST /hls-put-url` calls. Verify each returns a signed URL and correct object key (`<recordingId>/<filename>`). On the client, watch the network tab for the PUT itself — status, headers, response body.

**3. R2 / custom domain routing is misconfigured.**  
The PUT succeeds (200), but when the player fetches the manifest from your public HLS domain, it 404s or serves stale content. Common causes:

- The public domain (e.g. `hls-streaming.example.com`) does not actually route to the R2 bucket
- The R2 bucket policy blocks public reads
- CORS on the R2 bucket rejects the player's origin (`GET`, `HEAD`, `Range` from your player's origin need to be allowed)
- CDN caching serves the manifest at zero segments long after new ones landed — set `Cache-Control: no-cache` on `.m3u8`, longer TTLs on `.aac` are fine (segment files are immutable)

**Verify**: `curl -I https://<your-hls-domain>/<recordingId>/manifest.m3u8`. If you get 404 but the object is in the bucket, it's a routing problem. If you get 200 but the body has only one `#EXTINF` and you know six segments have landed, it's a CDN cache issue.

**The three keys to remember**:
- **Object keys are `<recordingId>/<filename>`** — the sync agent uses the folder-per-recording layout as the object-key prefix.
- **Manifest is rewritten after every segment**, so every `manifest.m3u8` PUT overwrites the previous one at the same key. That is the point.
- **`stop()` seals the manifest with `#EXT-X-ENDLIST`** so players know it's VOD, not live. If the player is stuck showing "live" after stop, either `stop()` never completed on the client, or the final manifest PUT never landed.

---

## I keep getting "Auto-resume deferred" — is that a bug?

**No, it is by design.** When native detects that:

- An interruption ended and it should resume
- But your app is currently backgrounded

It emits `"Auto-resume deferred — bring app to foreground to continue"` and stops trying. This is intentional because:

- On iOS, retrying `setActive(true)` in the background hits Apple's documented permanent-fail bug (error 560557684) — retrying wastes CPU
- On Android, aggressive OEMs kill background retries anyway, and the CPU spinning is a battery drain

**The fix is JS-side**: watch `AppState` for foreground transitions, then retry `resume()` when the user comes back. See the [README interruption section](../README.md#-interruption-handling-in-detail) for the pattern.

**If you see it repeatedly even after wiring the AppState listener**:

1. Confirm your `useRef` for the deferred flag actually persists (a fresh render creates a new ref if you use `useState` instead)
2. Confirm `AppState.currentState === 'active'` when your listener fires — some apps get `'active'` events before they are fully foregrounded
3. Add a 300–500 ms delay before calling `resume()` — the OS needs time to complete the foreground handoff

---

## The example app works but my integration doesn't

**Symptom**: You cloned the example, it worked. You copied the code into your app, it doesn't.

**Most common causes, in order**:

1. **Missing background mode / permission**
   - iOS: `UIBackgroundModes` array must include `audio` in Info.plist
   - Android: `POST_NOTIFICATIONS` must be requested at runtime on API 33+ AND your app must have `FOREGROUND_SERVICE_MICROPHONE` merged from the library's manifest
2. **Old React Native / no New Architecture**  
   Anvil requires the New Architecture (Nitro Modules dependency). If you are on RN < 0.76 or have `newArchEnabled=false`, it will not work.
3. **`pod install` did not run after adding the package on iOS**  
   `cd ios && pod install --repo-update`
4. **You are running the example inside your own app's monorepo without the workspace linking**  
   The example uses `link:../` for the local package. In your own app, use the published version or set up proper linking.
5. **You are using `expo-audio` or another audio library at the same time**  
   Two audio session managers will fight each other. Use one at a time.
6. **You forgot to pass `recordingId`**  
   In 2.0, `recordingId` is required and caller-owned — it's the folder name for the recording. Anvil validates it as a single path segment (no `/`, `\`, `..`, NUL, ≤256 chars). A missing or invalid id rejects at `createRecorder`.

**Isolate**: Copy the _entire example App.tsx_ into your app as a single component and render it. If that works, the issue is in your integration code. If that fails too, the issue is your project setup (manifest, permissions, RN version).

---

## Emulator vs real device — what actually works where

**iOS Simulator**:

- ✅ Recording from host mic works
- ✅ Segment writing, manifest sealing and discovery work
- ⚠️ Interruption events don't fire naturally — you can trigger them with `Debug → Simulate Memory Warning` or by playing audio in another app, but the fidelity is poor
- ❌ CallKit call detection doesn't work (there is no phone in a simulator)
- ❌ Bluetooth route changes don't work
- ❌ Background mode behavior is unreliable

**Android Emulator**:

- ✅ Recording from host mic works (usually — some emulator configs deliver silence)
- ✅ Segment writing, manifest sealing and discovery work
- ⚠️ Audio focus events are unreliable — `AUDIOFOCUS_LOSS` might not fire when another emulator app takes the mic
- ⚠️ `onRecordingConfigChanged` behaves inconsistently
- ❌ Real phone calls don't exist; the emulator's "phone" control (extended controls → phone) doesn't fully mimic real call state transitions
- ❌ OEM battery optimization is not present (emulators run stock Android)

**Real device is the only ground truth** for anything touching interruptions, background, Bluetooth, or the OS's audio focus system. Test on iPhone + one Pixel + one aggressive OEM (Xiaomi or Samsung) before shipping.

---

## How to get useful logs to share

**iOS** (Xcode running):

```
Filter Console for: Anvil
```

Anvil logs everything at `NSLog` level with the `[Anvil]` prefix. Copy the full log window from just before the issue to just after.

**Android** (Android Studio or `adb`):

```bash
adb logcat -c   # clear
adb logcat | grep -E "Anvil|AnvilAudioFocus|AnvilCaptureLoop"
```

Filter for these tags. Everything Anvil does on Android goes through those three tags.

**JS side**:

```ts
recorder.addInterruptionListener((e) =>
  console.log('[interruption]', JSON.stringify(e))
);
recorder.addRouteChangeListener((r) =>
  console.log('[route]', JSON.stringify(r))
);
recorder.addPermissionChangeListener((s) => console.log('[perm]', s));
recorder.addStorageWarningListener((w) =>
  console.log('[storage]', JSON.stringify(w))
);
recorder.addSegmentCompletedListener((s) =>
  console.log('[segment]', JSON.stringify(s))
);
recorder.addManifestUpdatedListener((m) =>
  console.log('[manifest]', m.manifestPath, m.segmentCount)
);
recorder.addErrorListener((e) => console.log('[error]', e.code, e.message));
```

Wire all seven listeners during debugging. When something goes wrong, the JS log alone tells 70% of the story.

**When filing an issue**, include:

1. The exact device (`Build.MODEL` on Android, `UIDevice.current.model` on iOS) and OS version
2. Your `RecorderConfig` — literally the JSON you passed, including `sampleRate` and `aacBitrate`
3. The Anvil version from `package.json`
4. The React Native version
5. A logcat / Xcode Console snippet from 30 seconds before the issue to 5 seconds after
6. What you were doing (started recording, received a call, backgrounded, etc.)
7. For HLS-streaming issues: whether the sync agent was attached, backend endpoint URL, and a curl of the manifest from the public HLS domain

Without these seven items, the issue is almost impossible to reproduce.

---

## Still stuck?

- Search existing issues on [the GitHub repo](https://github.com/Gautham495/react-native-nitro-audio-anvil/issues)
- If your issue is OEM-specific, cross-reference with [dontkillmyapp.com](https://dontkillmyapp.com/) — sometimes their guide covers what you are hitting
- File a new issue with the seven items above and a **minimal reproduction** — a fork of the example app with your problem baked in, not just a description

The library is maintained by one person. Good repros get fixed. Vague reports sit in the backlog. Please respect that.
