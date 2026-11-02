#!/bin/sh
set -eu

# Use the standard macOS SDK location without requiring shell-profile edits.
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
export PATH="${JAVA_HOME:+$JAVA_HOME/bin:}$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

usb_serial=
if [ "${1:-}" = "install-release" ]; then
  if ! usb_serial=$(adb -d get-serialno) || [ "$usb_serial" = "unknown" ]; then
    printf 'Connect exactly one USB phone and authorize USB debugging.\n' >&2
    exit 1
  fi
  if [ "$(adb -s "$usb_serial" get-state 2>/dev/null || true)" != "device" ]; then
    printf 'Unlock the phone and authorize USB debugging, then retry.\n' >&2
    exit 1
  fi
  printf 'Building release for USB device %s\n' "$usb_serial"
  shift
  set -- build-release "$@"
fi

if [ "${1:-}" = "build-apk" ] || [ "${1:-}" = "build-release" ]; then
  variant=Debug
  if [ "$1" = "build-release" ]; then
    variant=Release
    python3 scripts/release-key.py
  fi
  shift
  if [ ! -f android/gradlew ]; then
    pnpm exec expo prebuild --platform android --no-install
  fi
  # Expo's native tooling can exhaust the generated 512 MB metaspace limit.
  ./android/gradlew -p android "app:assemble$variant" --max-workers=2 \
    '-Dorg.gradle.jvmargs=-Xmx2g -XX:MaxMetaspaceSize=1g' \
    -PreactNativeArchitectures=arm64-v8a "$@"
  kind=debug
  if [ "$variant" = "Release" ]; then kind=release; fi
  mkdir -p artifacts
  cp "android/app/build/outputs/apk/$kind/app-$kind.apk" "artifacts/agyspeak-$kind.apk"
  printf '\nAPK: %s/artifacts/agyspeak-%s.apk\n' "$PWD" "$kind"
  if [ -n "$usb_serial" ]; then
    app_id=$(node -p "require('./app.json').expo.android.package")
    adb -s "$usb_serial" install -r "artifacts/agyspeak-$kind.apk"
    adb -s "$usb_serial" shell am start -n "$app_id/.MainActivity"
  fi
  exit 0
fi

exec pnpm exec expo "$@"
