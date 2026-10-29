#!/bin/sh
set -eu

# Use the standard macOS SDK location without requiring shell-profile edits.
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
export PATH="${JAVA_HOME:+$JAVA_HOME/bin:}$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

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
  ./android/gradlew -p android "app:assemble$variant" --max-workers=2 -PreactNativeArchitectures=arm64-v8a "$@"
  kind=debug
  if [ "$variant" = "Release" ]; then kind=release; fi
  mkdir -p artifacts
  cp "android/app/build/outputs/apk/$kind/app-$kind.apk" "artifacts/agyspeak-$kind.apk"
  printf '\nAPK: %s/artifacts/agyspeak-%s.apk\n' "$PWD" "$kind"
  exit 0
fi

exec pnpm exec expo "$@"
