import { createContext, use, useMemo, type ReactNode } from "react";
import type { Startup } from "./useResources";
import { ChatScopeProvider } from "../features/chat/chatContext";
import { SettingsScopeProvider } from "../features/settings/settingsContext";
import { Failure } from "../ui/Failure";

const StartupContext = createContext<{
  startup: Startup;
  retry: () => void;
} | null>(null);

// Gives each feature only what it may reach from the opened resources, as soon
// as those are open. Navigation stays mounted throughout startup.
export function AppScope({
  startup,
  retry,
  children,
}: {
  startup: Startup;
  retry: () => void;
  children: ReactNode;
}) {
  const resources = startup.status === "ready" ? startup.resources : null;
  const core = startup.status === "failed" ? null : startup.core;
  const chat = useMemo(
    () =>
      resources && {
        chat: resources.chat,
        connection: {
          state: resources.connection.state,
          reload: () => resources.connection.reload(),
        },
        preferences: resources.preferences.state,
        audio: resources.audio,
        speech: resources.speech,
        responseSpeech: resources.responseSpeech,
      },
    [resources],
  );
  const connection = core?.connection;
  const preferences = core?.preferences;
  const settings = useMemo(
    () => connection && preferences && { connection, preferences },
    [connection, preferences],
  );
  const status = useMemo(() => ({ startup, retry }), [startup, retry]);
  return (
    <StartupContext value={status}>
      <ChatScopeProvider scope={chat}>
        <SettingsScopeProvider scope={settings ?? null}>
          {children}
        </SettingsScopeProvider>
      </ChatScopeProvider>
    </StartupContext>
  );
}

// Fills a destination's data region while startup has not opened it: nothing
// while opening, or the failure with its details and a clean retry.
export function StartupStatus() {
  const scope = use(StartupContext);
  if (!scope) throw new Error("Destination rendered outside the app scope.");
  const { startup, retry } = scope;
  if (startup.status !== "failed") return null;
  return <StartupFailure error={startup.error} onRetry={retry} />;
}

function StartupFailure({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <Failure
      message="Couldn’t open your data."
      hint="Saved settings or chat history couldn’t be opened. Your data is kept."
      error={error}
      onRetry={onRetry}
      onDismiss={null}
    />
  );
}
