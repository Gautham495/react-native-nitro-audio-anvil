# iOS quirks — background microphone recording on iOS

**iOS is the well-behaved platform for background audio — until it isn't.** Unlike Android, there's no per-OEM battery-killer layer to fight; a correctly configured app records in the background reliably. But iOS has its own set of sharp edges, and every one of them is in the audio session and interruption machinery, not the file layer. This document is the field-tested list.

If you have not read the [interruption handling section](../README.md#-interruption-handling-in-detail) of the README, do that first. Most of what follows is the platform detail beneath that section.

---

## The short version

| Symptom                                                        | Cause                                                                                                  | Fix                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Recording doesn't resume after a phone call while backgrounded | `AVAudioSession.setActive(true)` permanently fails in background after a call interruption (Apple bug) | Foreground-gate auto-resume; retry on `AppState` → `active`                |
| `AudioCodecInitialize failed` at `createRecorder`/`start`      | `aacBitrate` above the AAC-LC ceiling for the chosen `sampleRate`                                      | Lower bitrate or raise sample rate; `48000 / 96000` is the safe default    |
| Voice sounds robotic / thin / metallic                         | `.measurement` session mode, or a resampler running because your `sampleRate` ≠ mic-native             | Use `.default` mode (Anvil's default); record at 48 kHz                    |
| Recording stops ~30 s after backgrounding                      | `UIBackgroundModes` missing `audio`                                                                    | Add it to Info.plist                                                       |
| Segment splits or silence when a headset connects              | Route change; SCO/Bluetooth input swap                                                                 | Expected — Anvil rotates the segment; the audio is intact                  |
| Everything breaks after a call/Control-Center audio glitch     | `mediaServicesWereReset` — the whole audio stack was torn down                                         | Anvil treats it as an interruption and rebuilds; wire the same resume path |
| Interruptions never fire in the simulator                      | The simulator's audio stack isn't real                                                                 | Test on a device — the simulator lies                                      |

The rest of this document is each of these in detail.

---

## Background reactivation permanent-fail (the big one)

**Verdict**: The single most important iOS quirk. If you get one thing right, get this.

**Symptom**: User is recording, a phone call comes in, they take it with your app backgrounded, they hang up — and the recording never resumes. On the next foreground it may or may not come back depending on how you wired resume.

**What's actually happening**: After a phone-call interruption ends, iOS sends the interruption-ended notification with a `shouldResume` hint. But if your app is **in the background** when you call `AVAudioSession.setActive(true)` to resume, the call **fails — and keeps failing, permanently, for the lifetime of that session**, with error `561015905` / `AVAudioSessionErrorCodeCannotStartPlaying` or a generic `560557684`. This is a long-standing Apple platform bug, not something you can retry your way out of. Retrying `setActive(true)` in the background just burns CPU against a wall.

**The only thing that clears it**: the app coming to the foreground. Once foregrounded, `setActive(true)` succeeds normally.

**What Anvil does**: on interruption-end, native checks the foreground state _before_ attempting resume. If backgrounded, it does **not** retry in a loop — it emits an error with the message `Auto-resume deferred — bring app to foreground to continue` and stops. Retrying while backgrounded is pointless (the bug) and wasteful.

**What your app must do**: wire an `AppState` listener that, on the transition to `active`, retries `recorder.resume()` if a deferred flag is set. This is the pattern in the [README interruption section](../README.md#-interruption-handling-in-detail) — it is not optional on iOS, it's the other half of the fix. Without it, a call taken with your app backgrounded ends the recording until the user manually taps resume.

**Verify**: look for the exact string `Auto-resume deferred` in your `addErrorListener`. If you see it, this is the bug and the AppState listener is the fix. If instead you see `Auto-resume failed after N attempts`, native _was_ foreground and hit the retry cap — a different problem (the other app is still holding the mic; see the README).

---

## AAC-LC bitrate ceiling — `AudioCodecInitialize failed`

**Verdict**: A hard failure at recorder creation that looks cryptic but has a simple cause.

**Symptom**: `Anvil.createRecorder(...)` or the first `start()` throws on iOS with a message mentioning `AudioCodecInitialize` (often surfacing from `CodecConverter.cpp`), or `kAudio_ParamError`. Reproduces on both simulator and device.

**Cause**: The `aacBitrate` you configured is above the AAC-LC maximum for the chosen `sampleRate`. AAC-LC has a per-sample-rate bitrate ceiling — a bitrate that's fine at 48 kHz is rejected outright at 16 kHz mono. `AVAudioConverter` doesn't clamp; it fails codec init with an opaque error.

**The ceiling Anvil enforces** (mono, matching the AAC-LC spec):

| Sample rate | Max `aacBitrate` (mono) |
| ----------- | ----------------------- |
| 8 000 Hz    | 24 000 bps              |
| 16 000 Hz   | 48 000 bps              |
| 22 050 Hz   | 64 000 bps              |
| 24 000 Hz   | 72 000 bps              |
| 32 000 Hz   | 96 000 bps              |
| 44 100 Hz   | 192 000 bps             |
| 48 000 Hz   | 192 000 bps             |

**Fix**: either lower `aacBitrate` for your sample rate, or raise the sample rate. `sampleRate: 48000, aacBitrate: 96000` is the recommended default for voice — it's the mic-native rate on modern iPhones (so no resampler, see below), it's comfortably under the ceiling, and 96 kbps mono is transparent for speech.

Anvil's `RecorderConfigValidator` throws a readable error for a bad combination _before_ the native codec is touched, so you get a clear message at `createRecorder(...)` rather than a `CodecConverter.cpp` crash mid-recording. If you're seeing the raw codec error, you're on a build without the validator or you bypassed it.

---

## Robotic / thin / metallic voice

**Verdict**: Two distinct iOS causes, both in the capture path, both fixable in config.

**Symptom**: Recording completes and plays, but the voice sounds robotic, underwater, pitched-off, or has a persistent artifact. Playing the raw `.aac` segment in VLC sounds bad too (so it's capture-side, not your player).

**Cause 1 — wrong audio session mode.** `AVAudioSession` mode `.measurement` disables the input processing chain (AGC, echo cancellation) and behaves differently from `.default`. It's meant for scientific measurement, not meeting audio, and it produces thin/robotic voice. **Anvil uses `.default`.** If you patched `AnvilAudioSession` to `.measurement`, revert it.

**Cause 2 — the resampler is doing work.** If you configure a `sampleRate` that isn't the mic's native rate (48 kHz on modern iPhones), `AVAudioConverter` runs a real-time resampler in the capture path, and under load it produces artifacts. This is the most common cause. **Fix**: record at 48 kHz. If a downstream model needs 16 kHz (many streaming STT services do), resample **after** the bytes are captured — on a worker, off the capture path — never by asking the mic for 16 kHz.

**Diagnose**: play `00000.aac` directly in VLC or ffplay. Bad in VLC → capture-side, one of the two above. Fine in VLC but bad in your app → your playback stack, not Anvil.

> There's a third cause that's platform-agnostic and lived in the encoder, not the session: an `AVAudioConverterInputBlock` that returns the same PCM buffer on every call (instead of flipping to `.noDataNow` after handing it over once) makes the converter emit duplicated frames — fast-forwarded, crackling audio. Anvil's encoder handles the input block correctly. If you forked `AacEncoder`, that's the thing to check.

---

## Background mode — `UIBackgroundModes`

**Verdict**: One Info.plist key stands between you and a recording that survives the lock screen.

**Symptom**: Recording runs fine while the app is foreground, then stops ~30 seconds after the user locks the phone or switches apps.

**Cause**: Without the `audio` background mode, iOS suspends your app shortly after backgrounding, which tears down capture.

**Fix**: in `Info.plist`:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Records your conversations</string>
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
```

`NSMicrophoneUsageDescription` is separately mandatory — without it the app is rejected at the permission prompt. `UIBackgroundModes = audio` is what keeps capture alive when backgrounded. There is no OEM layer to also fight, unlike Android — on iOS this one key is the whole story for background survival.

---

## CarPlay and Bluetooth route chaos

**Verdict**: iOS route changes are frequent and sometimes nonsensical; the goal is that they never corrupt a segment.

**What happens**: connecting or disconnecting a Bluetooth headset, plugging in wired headphones, CarPlay attaching/detaching, or Control Center swapping output all fire `routeChangeNotification`. Some of these swap the _input_ device mid-recording; some are output-only but still churn the session.

**What Anvil does**: on a route change that affects the input, it finalizes the current segment and starts a fresh one, so no single `.aac` ever mixes two input devices. You get a `routeChange` event and a clean segment boundary.

**The Bluetooth-specific trap**: when a Bluetooth headset's microphone becomes the input, iOS switches the whole link to the low-bandwidth SCO codec (the "phone call" Bluetooth mode) — 8 or 16 kHz, muffled. This is a Bluetooth hardware limitation, not an Anvil bug: BT can't do high-quality output and mic input simultaneously. If a user records with AirPods as the input, the audio _will_ be phone-call quality. The fix is product-level: prefer the built-in mic for recording, or warn the user. There is nothing the capture layer can do about SCO.

**CarPlay**: route changes on attach/detach are the main issue; they're handled the same as any route change (segment rotation). CarPlay itself doesn't break recording, it just generates route churn.

---

## Media services reset

**Verdict**: Rare, violent, and fully recoverable if you wire it.

**Symptom**: Everything audio suddenly dies mid-recording — often after another app's audio glitch, a Control Center fumble, or an OS hiccup.

**Cause**: `AVAudioSession` posts `mediaServicesWereResetNotification`. The entire audio server (`mediaserverd`) was torn down and restarted; every audio object your process held is now invalid. Apple's guidance is to dispose and rebuild everything.

**What Anvil does**: treats it exactly like an interruption — finalizes the current segment (so nothing on disk is lost), tears down the capture engine, emits an interruption event, and runs the same foreground-gated resume path. Because it's routed through the interruption machinery, the same `AppState` resume listener that fixes the background-call bug also recovers a media-services reset.

**What you do**: nothing extra — if you wired the interruption/resume pattern from the README, media-services reset is already covered.

---

## The simulator lies

**Verdict**: Useful for the file pipeline, useless for anything touching the audio session.

| Behaviour                                             | iOS Simulator                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Recording from the host mic                           | ✅ works                                                                                                           |
| Segment writing, manifest sealing, discovery/recovery | ✅ works                                                                                                           |
| Interruption events                                   | ⚠️ don't fire naturally; `Debug → Simulate Memory Warning` or playing audio in another app is a poor approximation |
| CallKit call detection                                | ❌ no phone in a simulator                                                                                         |
| Bluetooth / CarPlay route changes                     | ❌ no real routes                                                                                                  |
| Background-mode behaviour                             | ❌ unreliable                                                                                                      |
| The background reactivation bug                       | ❌ won't reproduce (needs a real call)                                                                             |

**The rule**: the simulator's virtual audio stack does not behave like real hardware. Anything involving interruptions, routes, background, or the phone-call resume bug **must** be tested on a device. The simulator is fine for verifying that segments write and recover correctly, and nothing more.

If you're chasing robotic audio in the simulator specifically, note that the simulator pipes your Mac's mic through the host CoreAudio stack, and if your Mac's input is a Bluetooth headset the same SCO downgrade applies at the host level — so simulator audio quality tells you nothing about device quality. Switch your Mac's input to the built-in mic, or just test on a device.

---

## The pragmatic ship

iOS needs far less babysitting than Android — there's no per-brand modal to build, no autostart whitelist, no user setup steps. The entire iOS reliability story is:

1. `UIBackgroundModes = audio` and `NSMicrophoneUsageDescription` in Info.plist.
2. The `AppState` foreground-resume listener from the README (fixes the background-call bug and media-services reset in one).
3. A sane `sampleRate` / `aacBitrate` (48000 / 96000) so codec init never fails and no resampler runs.

Get those three right and iOS records 60–90 minute meetings through calls, backgrounding, route changes and media resets without losing a file. The one thing you genuinely cannot fix is Bluetooth SCO input quality — that's physics, not code. Everything else on this page is handled at the library layer or with the one AppState listener.
