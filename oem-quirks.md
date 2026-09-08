# OEM quirks — background microphone recording on Android

**Every Android OEM ships their own battery optimization layer on top of stock Android.** Some are gentle. Some are hostile. This document is the field-tested list of what each brand does to background recording apps and what your users need to do — one-time — to make things reliable.

If you have not read the [interruption handling section](../README.md#-interruption-handling-in-detail) of the README, do that first. This document is for the layer beneath — the OEM overlays that kill your app **even when the foreground service is running correctly**.

---

## Why this is a user-facing problem, not a library bug

Anvil declares `FOREGROUND_SERVICE_MICROPHONE` and runs the recording on a `Service` with an ongoing notification. On stock Android (Pixel, Motorola, Nokia HMD), that is enough — the OS will not kill the service while the notification is visible.

On aggressive OEMs (Xiaomi/HyperOS, Huawei/HarmonyOS, Oppo/ColorOS, Vivo/OriginOS, Realme, older OnePlus/OxygenOS), the manufacturer replaces or extends Android's process manager with something more aggressive. It ignores the foreground service. It kills the notification. It sends `AUDIOFOCUS_LOSS` to your microphone. It marks your app as "unused" and freezes it. It re-enables battery optimization after every system update.

**You cannot fix this in code.** The setting lives in the user's device settings and must be flipped by the user. Every long-form recording app on Play Store faces this — some hide it, some warn, some ship an in-app modal. Ignoring it costs your users their recordings.

The rest of this document is the per-brand recipe. Ship it as an in-app modal, a support-doc link, or an onboarding step. Pair it with [react-native-device-info](https://github.com/react-native-device-info/react-native-device-info) to detect the brand and only show the relevant instructions.

---

## Aggression tier list

For the impatient — what you actually need to know:

| Tier             | Brands                                                       | User action required                                         |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **Hostile**      | Xiaomi (HyperOS/MIUI), Huawei/Honor, Oppo, Vivo/iQOO, Realme | 3–4 separate setting screens, re-check after every OS update |
| **Aggressive**   | OnePlus (OxygenOS), Samsung (One UI), Asus                   | 1–3 setting screens                                          |
| **Well-behaved** | Motorola/Lenovo, Nokia HMD, Google Pixel                     | Standard Android battery optimization disable                |

The lower on this list the user's phone sits, the more likely their recording just works. The higher, the more likely they lose 40 minutes of a meeting because HyperOS decided to save 0.3% battery.

---

## Xiaomi / Redmi / POCO (HyperOS, MIUI)

**Verdict**: The most hostile OEM for background recording. HyperOS was designed to keep the phone feeling fast at the cost of every background service on the device.

**What HyperOS does**:

- Kills all background apps within seconds of screen-off unless the app is on the Autostart whitelist
- Ignores the Android standard `FOREGROUND_SERVICE_MICROPHONE` flag
- Silently re-enables battery optimization after every major system update
- Clears "locked" recent apps under memory pressure, which happens often on 6 GB devices

**One-time setup the user must do:**

1. **Enable Autostart**  
   Settings → Apps → Manage apps → **YourApp** → Autostart → **ON**  
   Without this, the app cannot restart itself after being killed. Turn this on first; nothing else matters until it is.

2. **Set battery saver to No restrictions**  
   Settings → Apps → Manage apps → **YourApp** → Battery saver → **No restrictions**  
   The default is "Battery saver," which freezes the app after 1–2 minutes of screen-off. "No restrictions" is the only value that keeps recording alive.

3. **Lock the app in Recents**  
   Open the recent apps view → long-press YourApp's card → tap the lock icon.  
   This is the only way to keep HyperOS from clearing the app under memory pressure.

4. **Disable MIUI Optimization (advanced)**  
   Settings → Additional settings → Developer options → **MIUI Optimization: OFF**  
   Enable Developer options first by tapping "MIUI version" ten times in About phone. Only necessary if the above three still see recordings drop — this is the nuclear option that disables the aggressive killer entirely.

**Reference**: [dontkillmyapp.com/xiaomi](https://dontkillmyapp.com/xiaomi)

---

## Huawei / Honor (EMUI, MagicOS, HarmonyOS)

**Verdict**: Second-worst. Aggressive process management with a "Protected Apps" concept that must be manually populated.

**What EMUI/HarmonyOS does**:

- Restricts background microphone access even for foreground services
- Battery optimization ("Power Genie") resets after each system update
- Without the Protected Apps flag, kills apps within 5–10 minutes of screen-off
- Ignores standard Android app-lock hints — must use Huawei's own lock UI

**One-time setup:**

1. **Add YourApp to Protected Apps**  
   Settings → Battery → App launch → **YourApp** → Manage manually: ON → toggle ON all three: Auto-launch, Secondary launch, Run in background.  
   All three must be on. Missing one kills the app.

2. **Remove from Power-hungry apps list**  
   Settings → Battery → More settings → Power-hungry apps → confirm **YourApp** is NOT flagged. If it is, Huawei will restrict background execution.

3. **Lock in Recents**  
   Open recent apps → swipe down on YourApp's card → tap the lock icon.

**Reference**: [dontkillmyapp.com/huawei](https://dontkillmyapp.com/huawei)

---

## Oppo (ColorOS) & Realme

**Verdict**: Aggressive but predictable. Same ColorOS base, same three steps.

**What ColorOS does**:

- Kills background apps sometimes within 2 minutes of screen-off
- Auto-start disabled by default for all newly installed apps
- Re-enables restrictions after major updates

**One-time setup:**

1. **Enable auto-launch**  
   Settings → Privacy → Startup manager → **YourApp** → Allow auto-launch: ON.  
   Without this, the app cannot restart after being killed.

2. **Allow background running**  
   Settings → Battery → App battery management → **YourApp** → Allow background activity: ON + Optimize battery usage: OFF.

3. **Lock in Recents**  
   Open recent apps → three-dot menu on YourApp's card → **Lock**.

**Reference**: [dontkillmyapp.com/oppo](https://dontkillmyapp.com/oppo) · [dontkillmyapp.com/realme](https://dontkillmyapp.com/realme)

---

## Vivo / iQOO (FuntouchOS, OriginOS)

**Verdict**: Aggressive with one extra permission (High background power consumption) that is required for continuous mic access.

**What FuntouchOS/OriginOS does**:

- Kills all background apps not on its whitelist within minutes
- Requires an additional "High background power consumption" permission for continuous microphone use — no other OEM has this
- Auto-start OFF by default

**One-time setup:**

1. **Enable auto-start**  
   Settings → More settings → Permission manager → Autostart → **YourApp**: ON.

2. **Allow high background power consumption**  
   Settings → Battery → High background power consumption → Add **YourApp**.  
   This is the Vivo-specific step. Without it, the mic capture stops after the screen locks even if auto-start is on.

3. **Lock in Recents**  
   Open recent apps → swipe down on YourApp's card → tap the lock icon.

**Reference**: [dontkillmyapp.com/vivo](https://dontkillmyapp.com/vivo)

---

## OnePlus (OxygenOS)

**Verdict**: Looks like stock Android but hides aggressive optimizations under the hood.

**What OxygenOS does**:

- "Deep optimization" and "Sleep standby optimization" are both ON by default — both kill background apps
- "Pause app activity if unused" freezes apps that go a few days unused
- Settings silently re-enable themselves after firmware updates

**One-time setup:**

1. **Disable Deep optimization**  
   Settings → Battery → Battery optimization → ⋮ → Advanced optimization → Deep optimization: OFF + Sleep standby optimization: OFF.  
   Both are on by default and kill background services within minutes.

2. **Disable "Pause app activity"**  
   Long-press YourApp icon → App info → scroll to bottom → **Pause app activity if unused**: OFF.  
   Prevents OxygenOS from auto-pausing the app after days of infrequent use.

3. **Allow background activity**  
   Settings → Battery → More settings → App battery management → **YourApp** → Allow background activity: ON.

4. **Lock in Recents**  
   Open the app switcher → three-dot icon above YourApp's card → **Lock**.

**Reference**: [dontkillmyapp.com/oneplus](https://dontkillmyapp.com/oneplus)

---

## Samsung (One UI)

**Verdict**: Handles background audio reasonably well IF the app is not put to sleep by One UI's app management. Watch out for "Sleeping" and "Deep sleeping" states.

**What One UI does**:

- Puts unused apps into "Sleeping" mode after 3 days, "Deep sleeping" after 16 days
- A sleeping app cannot record in background even with a foreground service running
- Some Samsung firmwares add apps to "Background usage limits" without asking

**One-time setup:**

1. **Add YourApp to Never sleeping apps**  
   Settings → Battery and device care → Battery → Background usage limits → **Never sleeping apps** → **+** → add YourApp.  
   This prevents One UI from ever putting the app to sleep.

2. **Remove from Sleeping apps if listed**  
   Settings → Battery and device care → Battery → Background usage limits → Sleeping apps and Deep sleeping apps → verify YourApp is not in either list. If it is, remove it.

3. **Set battery to Unrestricted**  
   Settings → Apps → **YourApp** → Battery → **Unrestricted**.

**Reference**: [dontkillmyapp.com/samsung](https://dontkillmyapp.com/samsung)

---

## Asus (ROG UI, ZenUI)

**Verdict**: Medium aggression. One Auto-start setting and one battery optimization.

**One-time setup:**

1. **Enable Auto-start**  
   Auto-start Manager → Downloaded → **YourApp**: ON.  
   Or, on some ZenUI versions: Mobile Manager → Boost → Auto-start.

2. **Disable battery optimization**  
   Settings → Apps → **YourApp** → Battery → Battery usage → **Unrestricted**.

**Reference**: [dontkillmyapp.com/asus](https://dontkillmyapp.com/asus)

---

## Motorola / Lenovo

**Verdict**: Near-stock Android. Standard battery optimization is enough.

**One-time setup:**

1. **Disable battery optimization**  
   Settings → Battery → Battery optimization → **YourApp** → **Don't optimize**.

2. **Allow background activity**  
   Settings → Apps → **YourApp** → Battery → **Unrestricted**.

---

## Nokia (HMD)

**Verdict**: Near-stock Android. Same as Motorola.

**One-time setup:**

1. **Disable battery optimization**  
   Settings → Apps → **YourApp** → Battery → Battery optimization → **Don't optimize**.

---

## Google Pixel

**Verdict**: The friendliest Android for background recording. Adaptive Battery may still restrict rarely-used apps.

**One-time setup:**

1. **Set YourApp to Unrestricted**  
   Settings → Apps → **YourApp** → App battery usage → **Unrestricted**.  
   Exempts the app from Adaptive Battery restrictions.

**Note**: Battery Saver mode overrides this even for Unrestricted apps. If the user turns on Battery Saver, background recording will be throttled. Consider surfacing a warning if you detect it.

---

## Detecting the brand in your app

Use [react-native-device-info](https://github.com/react-native-device-info/react-native-device-info):

```ts
import DeviceInfo from 'react-native-device-info';

const manufacturer = (await DeviceInfo.getManufacturer()).toLowerCase();
const brand = (DeviceInfo.getBrand() || '').toLowerCase();
const combined = `${manufacturer} ${brand}`;

function detectBrand(combined: string) {
  if (/xiaomi|redmi|poco/.test(combined)) return 'xiaomi';
  if (/huawei|honor/.test(combined)) return 'huawei';
  if (/oppo/.test(combined)) return 'oppo';
  if (/vivo|iqoo/.test(combined)) return 'vivo';
  if (/realme/.test(combined)) return 'realme';
  if (/oneplus/.test(combined)) return 'oneplus';
  if (/samsung/.test(combined)) return 'samsung';
  if (/asus/.test(combined)) return 'asus';
  if (/lenovo|motorola/.test(combined)) return 'motorola';
  if (/nokia|hmd/.test(combined)) return 'nokia';
  if (/google|pixel/.test(combined)) return 'pixel';
  return 'generic';
}
```

Then either:

- Show an in-app modal on first launch that walks the user through their brand's steps
- Trigger the modal after the first "Auto-resume failed after N attempts" error, since aggressive OEMs are exactly where auto-resume fails
- Add a "Recording reliability" section in your settings screen so the user can re-check

---

## The pragmatic ship

Do not try to detect brand-specific setting completion — the OEMs make that impossible on purpose. Show the modal, link to [dontkillmyapp.com/&lt;brand&gt;](https://dontkillmyapp.com/) for the deep-dive version they can revisit, and provide an "I've done this" button that dismisses the modal. Track that dismissal in your analytics — reps who complete the setup have 99%+ reliability, reps who don't will file support tickets you can pattern-match.

**This is not perfect, and it will not be.** The OEM overlay landscape churns every 6 months, dontkillmyapp.com stays roughly current, and you will still get support tickets from HyperOS 3.1 users after a system update reset their settings. That is the cost of shipping on Android. iOS trades this for its own set of problems (background reactivation permanent-fail bug, CarPlay routing chaos). Both are ok. Neither is fixable at the library layer.

Ship the modal. Move on.
