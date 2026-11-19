import {
  createContext,
  use,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ConnectionState } from "../../connections/openrouter";
import type { ChatCoordinator, ChatState } from "./runtime/coordinator";
import { summarizeDraft, type DraftSummary } from "./storage/contracts";
import { audioInputIssue, imageInputIssue } from "./runtime/capability";
import type { PreferencesOwner } from "../../preferences/preferences";
import type { AudioArbiter } from "../../device/audio";
import type { SpeechSession } from "../../device/speech/SpeechSession";
import type { ResponseSpeech } from "./runtime/responseSpeech";
import { useModelCatalog } from "../../providers/openrouter/hooks";

// What the chat feature may reach: chat intentions and published chat state,
// non-secret connection status and the default model. No credentials.
export type ChatFeatureScope = {
  chat: ChatCoordinator;
  connection: {
    state: StoreApi<ConnectionState>;
    reload: () => Promise<void>;
  };
  preferences: PreferencesOwner["state"];
  audio: AudioArbiter;
  speech: SpeechSession;
  responseSpeech: ResponseSpeech;
};

const ChatScopeContext = createContext<ChatFeatureScope | null>(null);

export function ChatScopeProvider({
  scope,
  children,
}: {
  scope: ChatFeatureScope | null;
  children: ReactNode;
}) {
  return <ChatScopeContext value={scope}>{children}</ChatScopeContext>;
}

// The scope for regions mounted from the first frame: null until the chats
// are open.
export function useOpenChatScope() {
  return use(ChatScopeContext);
}

const closedSubscribe = () => () => {};

// A chat state value once the chats are open, `closed` until then. `closed`
// and the selected value must be stable between renders.
export function useOpenChatState<T>(
  selector: (state: ChatState) => T,
  closed: T,
): T {
  const store = use(ChatScopeContext)?.chat.state;
  return useSyncExternalStore(store?.subscribe ?? closedSubscribe, () =>
    store ? selector(store.getState()) : closed,
  );
}

export function useChatScope() {
  const scope = use(ChatScopeContext);
  if (!scope) throw new Error("Chat feature used outside its scope.");
  return scope;
}

export function useChatState<T>(selector: (state: ChatState) => T) {
  return useStore(useChatScope().chat.state, selector);
}

// The draft of chat `id`: live while it is the workspace, otherwise `stored`,
// as last read.
export function useDraftPreview(
  id: string,
  stored: DraftSummary,
): DraftSummary {
  const draft = useChatState((state) => state.draft);
  const text = useSyncExternalStore(draft.subscribe, () =>
    draft.chatId === id ? draft.value.text : null,
  );
  const photos = useSyncExternalStore(draft.subscribe, () =>
    draft.chatId === id ? draft.getPhotos().length : 0,
  );
  if (text !== null) return summarizeDraft(text, photos);
  return stored;
}

// The header's model name, empty until the chats are open.
export function useOpenChatModelName() {
  const scope = use(ChatScopeContext);
  const defaultModel = useSyncExternalStore(
    scope?.preferences.subscribe ?? closedSubscribe,
    () => scope?.preferences.getState().defaultModel ?? null,
  );
  const selected = useOpenChatState(
    (state) => state.history.selectedModel,
    null,
  );
  const catalog = useModelCatalog();
  const model = scope ? (selected ?? defaultModel ?? "") : "";
  return catalog.models.find((item) => item.id === model)?.name ?? model;
}

// The conversation's effective model and its capability feedback.
export function useChatModel() {
  const { preferences } = useChatScope();
  const defaultModel = useStore(preferences, (state) => state.defaultModel);
  const selected = useChatState((state) => state.history.selectedModel);
  const catalog = useModelCatalog();
  const model = selected ?? defaultModel;
  return {
    model,
    audioIssue: audioInputIssue(model, catalog.models),
    imageIssue: imageInputIssue(model, catalog.models),
  };
}
