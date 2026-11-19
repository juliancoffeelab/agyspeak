import { createStore } from "zustand/vanilla";

// Something the person is told and can only acknowledge. `message` is null
// when the title says it all.
export type Notice = { title: string; message: string | null };

// The notices waiting to be acknowledged, oldest first. Anything may tell
// the person something, including code outside the component tree.
export const notices = createStore<readonly Notice[]>(() => []);

export function notify(title: string, message: string | null) {
  notices.setState((waiting) => [...waiting, { title, message }], true);
}

export function acknowledgeNotice() {
  notices.setState((waiting) => waiting.slice(1), true);
}
