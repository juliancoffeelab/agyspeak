.PHONY: android check lint format format-check

android: check
	pnpm --dir reactnative android:usb

check:
	pnpm --dir reactnative check

lint:
	pnpm --dir reactnative lint

format:
	pnpm --dir reactnative format

format-check:
	pnpm --dir reactnative format:check
