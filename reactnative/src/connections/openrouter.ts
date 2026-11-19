import { createStore } from "zustand/vanilla";
import { parseKeyInput } from "../providers/openrouter/key.ts";

export const API_KEY_STORAGE_KEY = "agyspeak.openrouter.api-key.v1";

// Reads the saved key in its current format: absent or empty means
// disconnected; anything else must already be a normalized key. An unreadable
// key rejects, so startup stops with the stored value intact.
export async function readSavedKey(secure: {
  get: (key: string) => Promise<string | null>;
}): Promise<string> {
  const value = await secure.get(API_KEY_STORAGE_KEY);
  if (!value) return "";
  if (parseKeyInput(value) !== value)
    throw new Error("The saved OpenRouter key is invalid.");
  return value;
}

type SecretStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
};

// Distinguishes connection owners that share one query cache across resource
// scopes; revisions restart at 0 for every owner.
let lifetimes = 0;

// Public connection state carries no secret. Until the saved key is read it
// is neither connected nor disconnected; a key that can't be read is a
// failure, not an absent key. `revision` changes whenever the saved
// credential is replaced or removed.
export type KeyStatus =
  | { status: "reading" }
  | { status: "failed"; failure: unknown }
  | { status: "ready"; connected: boolean };
export type ConnectionState = KeyStatus & { revision: number };
export type Credential = { apiKey: string; lifetime: number; revision: number };

// Owns the saved key and reads it in the background. A save is accepted only
// once the key is read and a read runs only while it isn't, so the two never
// overlap and only saves are queued.
export function createOpenRouterConnection(secure: SecretStore) {
  const lifetime = ++lifetimes;
  let apiKey = "";
  let retired = false;
  const state = createStore<ConnectionState>(() => ({
    status: "reading",
    revision: 0,
  }));
  // Each status replaces the previous one whole. Only a saved key moves the
  // revision on.
  const publish = (status: KeyStatus, revision: number) =>
    state.setState({ ...status, revision }, true);
  const revision = () => state.getState().revision;
  const read = () =>
    readSavedKey(secure).then(
      (key) => {
        if (retired) return;
        apiKey = key;
        publish({ status: "ready", connected: Boolean(key) }, revision());
      },
      (failure: unknown) => {
        if (retired) return;
        publish(
          {
            status: "failed",
            failure: failure ?? new Error("Unknown failure."),
          },
          revision(),
        );
      },
    );
  let reading = read();
  let writes: Promise<unknown> = Promise.resolve();
  return {
    lifetime,
    state,
    // Settles when the current read has a result, successful or not.
    read: () => reading,
    // Reads the saved key again after a failed read.
    reload() {
      if (retired || state.getState().status !== "failed") return reading;
      publish({ status: "reading" }, revision());
      reading = read();
      return reading;
    },
    // Capture once per request; later edits affect only later requests.
    capture(): Credential | null {
      const current = state.getState();
      return !retired && current.status === "ready" && apiKey
        ? { apiKey, lifetime, revision: current.revision }
        : null;
    },
    // Only the Settings editor reads the saved key back, once it's ready.
    readForEditing: () => apiKey,
    save(input: string) {
      if (retired)
        return Promise.reject(new Error("These settings were closed."));
      if (state.getState().status !== "ready")
        return Promise.reject(new Error("The saved key isn’t read yet."));
      const next = input.trim() ? parseKeyInput(input) : "";
      const result = writes.then(async () => {
        await secure.set(API_KEY_STORAGE_KEY, next);
        apiKey = next;
        publish({ status: "ready", connected: Boolean(next) }, revision() + 1);
      });
      writes = result.catch(() => undefined);
      return result;
    },
    // Rejects later saves and settles once every accepted save is durable.
    // A read still under way is abandoned: its result is never published.
    retire() {
      retired = true;
      return writes.then(() => undefined);
    },
  };
}
export type OpenRouterConnection = ReturnType<
  typeof createOpenRouterConnection
>;
