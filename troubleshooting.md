# Troubleshooting

**How to diagnose recording problems, in order of frequency.** Every entry has a symptom the user or developer sees, a hypothesis for what is actually happening underneath, and either a fix or a way to prove or disprove the hypothesis.

If you have not read the [interruption handling section](../README.md#-interruption-handling-in-detail) of the README or the [OEM quirks doc](./oem-quirks.md), do those first. Most support tickets fall in one of those two buckets.

---

## Contents

1. [Recording stops when I lock my phone](#recording-stops-when-i-lock-my-phone)
2. [After a phone call, recording does not auto-resume](#after-a-phone-call-recording-does-not-auto-resume)
3. [After WhatsApp / Voice Memos / Siri, recording does not auto-resume](#after-whatsapp--voice-memos--siri-recording-does-not-auto-resume)
4. [The recording file is empty or 0 bytes](#the-recording-file-is-empty-or-0-bytes)
5. [The recording file is corrupted / will not play](#the-recording-file-is-corrupted--will-not-play)
6. [Recording started but produces only silence](#recording-started-but-produces-only-silence)
7. [Segments are much smaller than expected](#segments-are-much-smaller-than-expected)
8. [I keep getting "Auto-resume deferred" — is that a bug?](#i-keep-getting-auto-resume-deferred--is-that-a-bug)
9. [The example app works but my integration doesn't](#the-example-app-works-but-my-integration-doesnt)
10. [Emulator vs real device — what actually works where](#emulator-vs-real-device--what-actually-works-where)
11. [How to get useful logs to share](#how-to-get-useful-logs-to-share)

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

## The recording file is empty or 0 bytes

**Symptom**: `recorder.stop()` returns segments but the file at `segment.filePath` is 0 bytes.

**Likely causes**:

1. **Permission was revoked mid-recording**. Check `permissionChange` events. If mic permission dropped during the recording, iOS/Android silently deliver silence.
2. **AudioRecord could not initialize on Android**. Check logcat for `IllegalStateException` or `AudioRecord: start() status -38`. Usually happens right after another app released the mic — the HAL is still in cleanup. Retry with backoff (Anvil already does this on native side, but if you are hitting it programmatically, wait 500–1000ms before retrying).
3. **iOS route changed to a device with no input**. Rare, but if the recording is going to Bluetooth and the Bluetooth device disconnects during a route change, the input source can become nil for a moment.

**Diagnosis**:

```ts
recorder.addErrorListener((err) =>
  console.log('[anvil]', err.code, err.message)
);
recorder.addPermissionChangeListener((s) => console.log('[perm]', s));
recorder.addRouteChangeListener((r) =>
  console.log('[route]', r.reason, r.inputName)
);
```

If none of those fire and you still get 0 bytes, the microphone hardware itself is not producing samples. This is a device-level issue — try recording with the built-in Voice Memos app to confirm the mic works at all.

---

## The recording file is corrupted / will not play

**Symptom**: The `.wav` file exists but no player will open it, or it plays for 0 seconds.

**Most likely cause**: The WAV header size field was never patched. Anvil patches the header every `fsyncIntervalMs` and once more on `stop()`. If the process was force-killed between `fsync` cycles, the header may still say "data size = 0" while the file has bytes.

**Fix**: Anvil handles this on next launch. Call `Anvil.discoverOrphanedRecordings(recordingsDir)` — it repairs any WAV headers that never got their final patch by reading the actual file size and rewriting the header. This runs automatically if you use `createRecordingService`.

**Manual repair** (if you have an orphaned file from before you integrated `discoverOrphanedRecordings`):

```ts
// The header repair is deterministic. If you have a raw PCM chunk you know is valid:
// - RIFF header should say file size = totalSize - 8
// - data chunk should say size = totalSize - 44 (standard 44-byte header)
// Anvil handles this internally; expose it if you need to.
```

If the file plays with a garbled first 44 bytes but valid audio after that, the header is definitely the issue. If the audio itself is garbled (crackling, jumping), that is a capture-side issue — usually the sample rate mismatch between what you configured and what the OS delivered (some Android OEMs ignore the requested sample rate).

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

---

## Segments are much smaller than expected

**Symptom**: You configured `segmentDurationMs: 30_000` but segments are 3 KB / 200 ms.

**Likely cause**: You are hitting interruptions constantly. Anvil finalizes the current segment on every interruption (call, focus loss, media services reset). If you are testing on an emulator with unstable audio, or on a real device with an OEM that keeps sending focus events, segments rotate.

**Diagnosis**:

```ts
recorder.addSegmentCompletedListener((s) => {
  console.log(
    'segment',
    s.index,
    'was_interrupted:',
    s.wasInterrupted,
    'reason:',
    s.interruptionReason
  );
});
recorder.addInterruptionListener((e) => {
  console.log('interruption', e.phase, e.reason);
});
```

If every segment has `wasInterrupted: true`, look at `reason` for the pattern. `focus` means audio focus is being taken repeatedly (OEM quirk or another audio app running). `route` means Bluetooth is flapping.

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
3. Add a 300–500ms delay before calling `resume()` — the OS needs time to complete the foreground handoff

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

**Isolate**: Copy the _entire example App.tsx_ into your app as a single component and render it. If that works, the issue is in your integration code. If that fails too, the issue is your project setup (manifest, permissions, RN version).

---

## Emulator vs real device — what actually works where

**iOS Simulator**:

- ✅ Recording from host mic works
- ✅ Segment writing and reading works
- ⚠️ Interruption events don't fire naturally — you can trigger them with `Debug → Simulate Memory Warning` or by playing audio in another app, but the fidelity is poor
- ❌ CallKit call detection doesn't work (there is no phone in a simulator)
- ❌ Bluetooth route changes don't work
- ❌ Background mode behavior is unreliable

**Android Emulator**:

- ✅ Recording from host mic works (usually — some emulator configs deliver silence)
- ✅ Segment writing and reading works
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
recorder.addErrorListener((e) => console.log('[error]', e.code, e.message));
```

Wire all six listeners during debugging. When something goes wrong, the JS log alone tells 70% of the story.

**When filing an issue**, include:

1. The exact device (`Build.MODEL` on Android, `UIDevice.current.model` on iOS) and OS version
2. Your `RecorderConfig` — literally the JSON you passed
3. The Anvil version from `package.json`
4. The React Native version
5. A logcat / Xcode Console snippet from 30 seconds before the issue to 5 seconds after
6. What you were doing (started recording, received a call, backgrounded, etc.)

Without these six items, the issue is almost impossible to reproduce.

---

## Still stuck?

- Search existing issues on [the GitHub repo](https://github.com/Gautham495/react-native-nitro-audio-anvil/issues)
- If your issue is OEM-specific, cross-reference with [dontkillmyapp.com](https://dontkillmyapp.com/) — sometimes their guide covers what you are hitting
- File a new issue with the six items above and a **minimal reproduction** — a fork of the example app with your problem baked in, not just a description

The library is maintained by one person. Good repros get fixed. Vague reports sit in the backlog. Please respect that.
