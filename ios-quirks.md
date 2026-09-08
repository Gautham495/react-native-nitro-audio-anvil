# iOS quirks — background microphone recording on Apple platforms

**iOS handles background audio better than Android does.** There is no OEM overlay, no Xiaomi HyperOS, no third-party battery killer. Apple owns the entire stack from silicon to `AVAudioSession` and enforces one consistent contract across every device.

That contract has bugs, undocumented behavior, and edge cases that only surface on real hardware. This document is the field-tested list of iOS quirks that affect long-form microphone recording — the ones that cost you a meeting if you do not know they exist.

If you have not read the [interruption handling section](../README.md#-interruption-handling-in-detail) of the README, do that first. This document is the layer beneath — the Apple-specific quirks that affect *how* Anvil implements that pattern.

---

## Why iOS is not automatically friendlier than Android

Yes, Apple owns the whole stack. No, that does not mean everything works.

- iOS has documented `AVAudioSession` bugs Apple has not fixed in years
- iOS enforces stricter rules on when background audio is allowed
- iOS route changes can silently switch your recording to a device that produces no input
- iOS returns "success" on session activation calls that actually failed
- CarPlay, AirPods, Bluetooth SCO, and speakerphone route in unpredictable ways
- The simulator lies about most of these behaviors, so you cannot catch them until you ship

The upside: once you know the quirks, they are stable. Apple does not ship an OS update every 6 months that resets user settings. Your fix on iOS 17 still works on iOS 18. On Android you re-verify every OEM after every major system update.

---

## Quirk tier list

For the impatient — what actually matters:

| Tier         | Quirk                                                     | Impact                                                              |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------------------- |
| **Critical** | Background reactivation permanent-fail after phone call  | Recording cannot resume until user foregrounds the app              |
| **Critical** | `UIBackgroundModes = audio` required for background      | Without it, iOS suspends the app within 30 seconds of backgrounding |
| **High**     | `AVAudioSession` category must include `.mixWithOthers` for polite coexistence | Otherwise your app forces other audio apps to stop, jarringly       |
| **High**     | Media services reset (rare Bluetooth chaos edge case)     | Full audio subsystem restart, session and engine both invalidated   |
| **Medium**   | Route change to Bluetooth mid-recording                   | Sample rate may change, requiring engine restart                    |
| **Medium**   | CarPlay routing overrides everything                      | Recording may route to car speakers instead of iPhone mic           |
| **Low**      | Simulator lies about interruption behavior                | Testing feels fine, real device fails                               |

---

## The Big One: Background reactivation permanent-fail after phone call

**The bug**: If your app is in the background when a phone-call interruption ends, `AVAudioSession.setActive(true)` returns error `560557684` ("Session activation failed") and **retrying does not help**. The session is permanently in the "interrupted" state until the user brings your app to the foreground.

**This is documented on the Apple Developer Forums** and has been open for years. Apple's own guidance is essentially "expect this and handle it gracefully."

**What Anvil does**:

- On native side, `handleInterruptionEnded` checks `UIApplication.shared.applicationState`
- If background, emit an error `"Auto-resume deferred — bring app to foreground to continue"` and stop retrying
- Do not waste CPU on retries that Apple has told us will never succeed

**What your app must do**:

Wire an `AppState` listener that watches for foreground transitions. When the user returns to your app, call `recorder.resume()` explicitly. The [README interruption section](../README.md#-interruption-handling-in-detail) shows the pattern.

**Test scenario**: Start recording → hit the home button → make a phone call → hang up → wait 30 seconds → open your app. Recording should resume within 500ms of foreground.

If it does not, one of two things is wrong:

1. The AppState listener is not wired (the most common problem)
2. The recorder reference in your closure is stale — use `useRef` not `useState` for the recorder

---

## `UIBackgroundModes = audio` in Info.plist

**Non-negotiable for background recording.** Without this entitlement in `Info.plist`, iOS suspends your app within 30 seconds of the user pressing the home button. Your capture stops, your PCM listener stops, and when the user comes back the recording is 30 seconds long.

**What to add**:

```xml
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
<key>NSMicrophoneUsageDescription</key>
<string>Records your conversations</string>
```

**A common mistake**: developers add `audio` to `UIBackgroundModes` but forget that the app must **also be actively producing or consuming audio** for iOS to keep it alive. Anvil's `AVAudioEngine` inputNode tap satisfies this — as long as the engine is running, iOS considers you an active audio app.

**If you background the app and immediately pause the recorder**, iOS still suspends you within 30 seconds. Background mode requires *active* audio work.

**Symptom this quirk causes**: Recordings that stop exactly around the 30-second mark after backgrounding. Confirm the entitlement, then confirm the engine is running (not paused) at the moment of backgrounding.

---

## AVAudioSession category and options

**The right category for long-form recording**:

```swift
try session.setCategory(
  .playAndRecord,          // or .record if you never play back
  mode: .voiceChat,        // tuned for speech, disables echo cancellation
  options: [
    .mixWithOthers,        // don't force other audio apps to stop
    .allowBluetooth,       // let AirPods work as input
    .defaultToSpeaker,     // route playback to speaker not receiver
  ]
)
```

**Why each option matters**:

- **`.mixWithOthers`** — Without this, activating your session forces Spotify, YouTube, and other audio apps to stop. Users perceive this as rude and buggy. With it, you politely coexist — you take the mic, they keep playing their audio ducked or at full volume.

- **`.allowBluetooth`** — Without this, connecting AirPods does not route the mic to them. AirPods keep playing audio from the phone speaker, awkwardly. With it, AirPods become a mic input.

- **`.defaultToSpeaker`** — Without this, `.playAndRecord` routes playback to the *receiver* (the tiny speaker near your ear). Users perceive this as "no sound." With it, playback comes from the loud speaker at the bottom of the phone.

**Common wrong combinations**:

- `.playAndRecord` without `.defaultToSpeaker` → playback through the receiver
- `.record` category with playback code elsewhere → your `AVAudioPlayer` silently fails
- No `.mixWithOthers` → hostile to other audio apps
- `.playback` category with recording code → recording silently fails

---

## Media services reset — the rare Bluetooth chaos edge case

**The bug**: iOS emits `AVAudioSession.mediaServicesWereResetNotification` when the audio subsystem restarts. This happens rarely but predictably:

- Bluetooth device drops out and reconnects mid-recording
- System audio glitch after a `mediaServicesWereLostNotification`
- Certain third-party audio apps crashing hard

**What happens**: Your `AVAudioSession` is invalidated. Your `AVAudioEngine` is invalidated. Any in-flight `AudioQueue` is destroyed. You cannot just call `resume()` — the whole session must be rebuilt from scratch.

**What Anvil does**:

- Listens for `mediaServicesWereResetNotification` on the shared session
- On fire: stops the engine, finalizes the current segment with `interruptionReason: .reset`, sets state to `.interrupted`
- Emits both a `began` and `ended` interruption event so JS can display "recording paused / recording resumed" in the UI
- Rebuilds the session (`setCategory` + `setActive`) and restarts the engine

**Symptom this quirk causes**: A brief pause (500–2000ms) in the middle of a recording, always after a Bluetooth event. Users may or may not notice.

---

## Route changes mid-recording

**Symptoms**: User plugs in headphones → recording continues but sample rate jumps from 48kHz to 44.1kHz. User plugs into car via CarPlay → recording routes to CarPlay mic (usually a lower-quality far-field mic). User's AirPods die → recording routes to iPhone bottom mic.

**What iOS does**: Emits `AVAudioSession.routeChangeNotification` with a reason (`.newDeviceAvailable`, `.oldDeviceUnavailable`, `.categoryChange`, etc.). Your `AVAudioEngine` may or may not restart automatically depending on the reason.

**What Anvil does**:

- Listens for route changes and emits a `routeChange` event
- Finalizes the current segment so no file mixes two input devices
- Restarts the engine on `.newDeviceAvailable` or `.oldDeviceUnavailable`

**The gotcha**: Some route changes come with a sample rate change your app is not prepared for. If you hardcoded `sampleRate: 16000` in your config but the new input is 44.1kHz, iOS will resample for you — but with mediocre quality. If you care about audio quality across route changes, listen for the change and re-verify the actual sample rate.

**Rare but real**: Route change to a device with no input available. This happens with certain Bluetooth accessories that report as "audio devices" but only support playback. Anvil handles this by returning silence until the route changes again.

---

## CarPlay is its own dimension

**CarPlay routes audio unpredictably.** When a user with an iPhone connects to CarPlay:

- Recording may route to the CarPlay microphone (usually far-field, lower quality)
- The iPhone's own mic is still available but not the default
- `AVAudioSession.currentRoute` reports a CarPlay device that behaves differently from Bluetooth
- Route changes happen mid-drive as the connection flaps

**What to do**:

- Check `AVAudioSession.sharedInstance().currentRoute` for a CarPlay device
- If detected mid-recording, surface a warning to the user: "You are connected to CarPlay. Recording quality may be reduced."
- Anvil does not currently auto-detect CarPlay — if this matters for your use case, add a check in your app layer using `AVAudioSessionPortDescription.portType == .carAudio`

**Not urgent** for most apps, but if you are recording customer meetings that happen while the rep drives, worth handling.

---

## Simulator lies

**The iOS Simulator behaves nothing like a real device for audio.** Do not use it as ground truth.

**Specifically**:

- ✅ Recording from the host Mac's microphone works
- ✅ Segment writing and reading works
- ❌ Interruption events fire inconsistently or not at all
- ❌ CallKit call detection does not work (no phone in a simulator)
- ❌ Bluetooth route changes don't work
- ❌ Background mode behavior is unreliable — you can simulate backgrounding but the audio subsystem does not respond the way it does on device
- ❌ Media services reset never fires
- ❌ CarPlay never fires

**Every quirk in this document manifests on real hardware, not in the simulator.** Test on iPhone 14 or newer with a SIM card in it. Take an actual phone call. Connect actual AirPods. Ride an actual car with CarPlay. That is the only way to catch these.

---

## Common iOS-specific mistakes

Ranked from most-common to rarest:

1. **Forgetting `UIBackgroundModes = audio`** → recording stops on backgrounding
2. **Wiring interruption listener but not `AppState`** → recording pauses forever after a backgrounded phone call
3. **Using `.record` category then trying to play the recording** → silent playback
4. **Setting session category during a phone call** → `AVAudioSessionErrorCodeCannotStartRecording`
5. **Requesting permission with a vague `NSMicrophoneUsageDescription`** → App Store rejection
6. **Deactivating the session on `stop()` without `.notifyOthersOnDeactivation`** → other audio apps stay ducked forever
7. **Not handling `mediaServicesWereResetNotification`** → recording appears to work but produces silence after a Bluetooth glitch

---

## What Anvil handles for you

The library takes care of the most painful quirks:

- ✅ `AVAudioSession` category setup (`.playAndRecord`, `.mixWithOthers`, `.allowBluetooth`, `.defaultToSpeaker`)
- ✅ Interruption notification handling with exponential backoff auto-resume
- ✅ Foreground check before retrying (works around the background-reactivation permanent-fail bug)
- ✅ `mediaServicesWereResetNotification` handling with session rebuild
- ✅ Route change handling with segment rotation
- ✅ Segment finalization on every interruption so no bytes are lost
- ✅ Permission monitoring — if the user revokes permission mid-recording, you get an event
- ✅ WAV header patching + fsync so a crash never corrupts the file

What you must do at the app layer:

- ⚠️ Add `UIBackgroundModes = audio` to your `Info.plist`
- ⚠️ Wire an `AppState` listener for deferred-resume-on-foreground
- ⚠️ Handle CarPlay if it matters for your use case
- ⚠️ Test on real hardware, not just the simulator

---

## References

- [Apple Developer Forums: Session activation failed after phone call](https://developer.apple.com/forums/thread/813278) — the permanent-fail bug in the wild
- [AVAudioSession Programming Guide](https://developer.apple.com/library/archive/documentation/Audio/Conceptual/AudioSessionProgrammingGuide/) — Apple's guide (dated but still the canonical reference)
- [WWDC25: Enhance your app's audio recording capabilities](https://developer.apple.com/videos/play/wwdc2025/251/) — iOS 26 Bluetooth capture improvements, Spatial Audio recording

---

## When something in this document breaks

Apple ships iOS updates every year. Most of these quirks have been stable for 5+ years, but Bluetooth stack changes, CarPlay updates, and occasional `AVAudioSession` behavior changes can invalidate parts of this document. If you hit an iOS issue that this document does not cover:

1. Check if it reproduces on the previous iOS version
2. Check the Apple Developer Forums for recent posts with the same error code
3. File an issue on the repo with the six-item bug report template from [troubleshooting.md](./troubleshooting.md)

This is a living document. Every real-world iOS quirk we hit lands here.
