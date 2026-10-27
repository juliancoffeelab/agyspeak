#!/bin/sh
set -eu

# Use the standard macOS SDK location without requiring shell-profile edits.
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
export PATH="${JAVA_HOME:+$JAVA_HOME/bin:}$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

if [ "${1:-}" = "build-apk" ]; then
  shift
  pnpm exec expo prebuild --platform android --no-install
  exec ./android/gradlew -p android app:assembleDebug --max-workers=2 -PreactNativeArchitectures=arm64-v8a "$@"
fi

exec pnpm exec expo "$@"
