# AGSpeak for Android

A voice-first chat app: talk, type or attach photos, and have replies read
aloud. It talks to [OpenRouter](https://openrouter.ai) directly from the phone,
so it needs your own OpenRouter API key, entered in the app's Settings.
Messages are billed to that key. Chats are stored on the phone.

## Requirements

- Node.js LTS and pnpm
- Android Studio, for the Android SDK and its JDK
- An Android phone with USB debugging enabled, or an emulator

Builds run locally; no Expo account is needed.

## Run

From this directory:

```sh
pnpm install
pnpm android       # development build, served by `pnpm start` from then on
pnpm android:usb   # standalone release build, installed on the USB phone
pnpm build:release # release APK only, written to artifacts/
pnpm check         # format, lint, types and offline tests
```
