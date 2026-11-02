.PHONY: android check lint

android: check
	pnpm --dir reactnative android:usb

check:
	pnpm --dir reactnative check

lint:
	pnpm --dir reactnative lint
