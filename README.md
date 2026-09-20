# Screenly — Production Packaging

This folder turns the existing Screenly app into something that can run
as a normal web app, a PWA, and (once you build it on your own machine)
an Android APK and an iOS project. **Nothing about Screenly's UI,
features, mascot, navigation, or workflows was changed.** Only the
storage/AI plumbing gained a second, standalone mode.

## What's real vs. what still needs you

| Piece | Status |
|---|---|
| `www/index.html` | ✅ Your existing Screenly app, unmodified except for the dual-mode adapter (see below) |
| `server/server.js` | ✅ Real, working Express server code (DB + secure AI proxy) — written but **not run** here (this sandbox has no internet, so `npm install` can't fetch packages) |
| `manifest.json`, `sw.js`, `icons/` | ✅ Real PWA files. Icons are **coral placeholders** — no mascot image has ever actually been uploaded in this chat, so I generated a plain "SC" icon instead of guessing at the mascot's appearance. Drop your real mascot PNGs into `www/icons/` (192×192, 512×512, and a 512×512 maskable version) to replace them. |
| `capacitor.config.json`, root `package.json` | ✅ Real config, ready for `npx cap add android` / `ios` |
| Android APK | ❌ **Not built.** This sandbox has no Android SDK/Gradle and no internet access to download Capacitor's Android template. See Step 3 below to build it yourself. |
| iOS project/build | ❌ **Not built, and can't be, in any Linux sandbox.** Xcode only runs on macOS — this isn't a permissions issue, it's a platform requirement. You'll need a Mac (or a cloud Mac CI like Codemagic/Ionic Appflow). |

## How the dual-mode adapter works

Inside `www/index.html`, `initCapabilities()` now checks for `window.claude`:

- **Inside Claude.ai** (the artifact you already have published): behaves exactly as before, using Claude's built-in `db` and `sample` capabilities. This mode does not work outside Claude.ai — that's a hard platform limitation, not a bug.
- **Everywhere else** (your own domain, Capacitor Android, Capacitor iOS): calls `/api/db/*` and `/api/ai` on `server/server.js` instead. Every other line of app code — screening, talent sourcing, interviews, everything — is untouched, because the REST adapter mimics the exact same method shapes (`collection().doc().get/set/delete`, `.acquire()`, `sample.json()`).

## Step 1 — Run it as a normal web app (do this first)

```bash
cd screenly-app
cp .env.example .env
# edit .env: at minimum set GEMINI_API_KEY to a Google Gemini API key
cd server
npm install
npm start
```

Open `http://localhost:8787` — you now have a fully standalone Screenly
running on plain Node/Express, with your data in `server/data/*.json`
(swap for a real database later — see the comment in `server.js`).

Deploy this same `server/` folder to any Node host (Render, Railway,
Fly.io, a VPS, etc.) to get a real `https://screenly.yourdomain.com`.

## Step 2 — PWA install

Once deployed over HTTPS, open the site on a phone:
- **iPhone (Safari):** Share → "Add to Home Screen"
- **Android (Chrome):** menu → "Install app" / "Add to Home screen"

This already works — `manifest.json` + `sw.js` are wired up and linked
from `index.html`.

## Step 3 — Android APK (run this on your own machine, not in this chat)

This sandbox has no internet access and no Android SDK, so none of this
could be executed here. On a machine with Node.js, Android Studio, and
internet access:

```bash
cd screenly-app
npm install
npx cap add android
npx cap sync android
```

**Important:** before building, open `capacitor.config.json` and set
`server.url` to your deployed HTTPS URL from Step 1 (uncomment the two
`server` lines) — the native app needs a live backend, the same way
the web version does.

Then either:
```bash
npx cap open android      # opens Android Studio, click Run/Build > Build Bundle(s)/APK(s)
```
or from the command line once Android Studio has set up the `android/`
folder and its Gradle wrapper:
```bash
cd android
./gradlew assembleDebug
```
The debug APK will be at:
```
android/app/build/outputs/apk/debug/app-debug.apk
```

App ID used: **`com.screenly.hr`** (as requested). Change it in
`capacitor.config.json` before your first `cap add android` if you'd
prefer a different one.

## Step 4 — iOS project (requires a Mac)

```bash
npm install
npx cap add ios
npx cap sync ios
npx cap open ios
```
This opens Xcode, where you set your Apple Developer signing team and
build/run on a simulator or device, and eventually archive for
TestFlight/App Store. None of this can run without macOS + Xcode.

## Step 5 — Camera/permissions (Live Talent screening)

Screenly's Live Talent screening currently records **manual scores**
(camera test, dance tests) rather than capturing video inside the app
itself — so no camera/microphone permission is required yet. If you
later add actual in-app video recording, add to
`android/app/src/main/AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```
and to `ios/App/App/Info.plist`:
```xml
<key>NSCameraUsageDescription</key>
<string>Screenly uses the camera to record talent screening tests.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Screenly uses the microphone to record talent screening tests.</string>
```

## Security notes (Step 12/13 from the request)

- `GEMINI_API_KEY` lives only in `.env` on the server — the browser/app
  never sees it (`server.js`'s `/api/ai` route is the only thing that
  reads it).
- Set `AUTH_SECRET` in `.env` for anything beyond local testing; every
  `/api/*` route then requires `Authorization: Bearer <AUTH_SECRET>`.
  (Wiring that header into the front-end's fetch calls, tied to
  Screenly's existing username/password login, is the next step —
  not yet done here.)
- CVs are currently stored as extracted text inside candidate records,
  not as original PDF/DOCX files — there's no file storage to secure
  yet. `STORAGE_BUCKET`/keys in `.env.example` are placeholders for
  when you add real file uploads.
