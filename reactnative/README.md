# AGSpeak Android companion

React Native, Expo SDK 58, and TypeScript. This is the initial app scaffold;
recording, Mac pairing, and chat transport are not implemented yet. The planned
companion records and plays audio on the phone while the Mac runs `agy` and TTS.

## Development

Use Node.js LTS and pnpm 12.15.0. From this directory:

```sh
pnpm install
pnpm typecheck
pnpm android
```

`pnpm android` generates the native project, builds a development client, and
runs it on a connected Android device or emulator. A physical device needs USB
debugging enabled. Subsequent development sessions can use `pnpm start`.
No Expo account or cloud build service is required for local builds.

On macOS, the scripts default to `~/Library/Android/sdk` and Android Studio's
bundled JDK. Set `ANDROID_HOME` and `JAVA_HOME` to override those locations.
The current native dependencies require Android SDK Platform 37.0, Build-Tools
37.0.0 (plus 36.0.0 for Android build tasks), NDK 27.1.12297006, and CMake 3.22.1.

## Debug APK

```sh
pnpm build:apk
```

Builds an ARM64 development APK at
`android/app/build/outputs/apk/debug/app-debug.apk`. This development client
still needs the Metro server (`pnpm start`); it is not a standalone release.

## Layout

- `App.tsx`: app entry screen.
- `app.json`: app identity and native configuration.
- `android/`: generated native project, ignored by Git. Configure native changes
  through Expo config/plugins so they survive regeneration.
- `scripts/android.sh`: local Android toolchain defaults and build commands.
