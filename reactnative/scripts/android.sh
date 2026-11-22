#!/bin/sh
set -eu

# Use the standard macOS SDK location without requiring shell-profile edits.
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
export PATH="${JAVA_HOME:+$JAVA_HOME/bin:}$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

# A USB phone reaches Metro through the cable, on the port Metro listens on.
forwarded=
if [ "${1:-}" = "start" ]; then
  port=${RCT_METRO_PORT:-8081}
  previous=
  for argument in "$@"; do
    case "$previous" in --port | -p) port=$argument ;; esac
    case "$argument" in --port=*) port=${argument#--port=} ;; esac
    previous=$argument
  done
  # Expo picks another port when none is given or the given one is taken.
  case "$port" in
    '' | 0 | *[!0-9]*) port= ;;
    *) if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then port=; fi ;;
  esac
  forwarded=$port
  if [ "$(adb -d get-state 2>/dev/null || true)" != "device" ]; then
    printf 'No USB phone to forward Metro to; continuing.\n' >&2
  elif [ -n "$port" ]; then
    # A known, free port: forward it and start Metro, nothing more. A phone
    # that was detected but can't be forwarded to stops the start here.
    adb -d reverse "tcp:$port" "tcp:$port" >/dev/null
  else
    # Only Expo knows the port it ends up on. It forwards that port as part
    # of opening the app, so this start opens the app on the phone on purpose.
    set -- "$@" --android
  fi
fi

# Expo opens the dev app at the Mac's network address, which a phone on
# another network can't reach, and the app then reopens it on every plain
# launch. With a USB phone, name the cable's end instead; Expo forwards the
# port itself when it opens the app. The variable is Expo's own, undocumented.
case "${1:-}" in
  start | run:android)
    if [ "$(adb -d get-state 2>/dev/null || true)" = "device" ]; then
      export REACT_NATIVE_PACKAGER_HOSTNAME=localhost
    fi
    ;;
esac

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

# The forward belongs to the phone's USB session and goes whenever that is
# reset: a cable moved, the phone waking, adb restarting. Nothing puts it
# back, and the app then finds no Metro. Keep it up while Metro runs, for a
# phone attached later too. This shell becomes Metro below, so its process is
# the one to outlive. Only for a port known here; Expo's own pick isn't.
if [ -n "$forwarded" ]; then
  (
    while kill -0 $$ 2>/dev/null; do
      sleep 3
      adb -d reverse "tcp:$forwarded" "tcp:$forwarded" || true
    done
  ) </dev/null >/dev/null 2>&1 &
fi

exec pnpm exec expo "$@"
