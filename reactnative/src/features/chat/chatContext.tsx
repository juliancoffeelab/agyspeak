import {
  createContext,
  use,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ConnectionState } from "../../connections/openrouter";
import type { ChatWorkspace, WorkspaceState } from "./runtime/workspace";
import type { ChatView } from "./runtime/chatRuntime";
import { budgetOf } from "./runtime/log";
import { summarizeDraft, type DraftSummary } from "./storage/contracts";
import type { PreferencesOwner } from "../../preferences/preferences";
import type { AudioArbiter } from "../../device/audio";
import type { SpeechSession } from "../../device/speech/SpeechSession";
import type { ResponseSpeech } from "./runtime/responseSpeech";
import { useModelCatalog } from "../../providers/openrouter/hooks";

// What the chat feature may reach: chat intentions and published chat state,
// non-secret connection status and the default model. No credentials.
export type ChatFeatureScope = {
  chat: ChatWorkspace;
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
  selector: (state: WorkspaceState) => T,
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

export function useChatState<T>(selector: (state: WorkspaceState) => T) {
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

// Whether chat `id` holds an unsent draft, for what is shown while the draft
// is typed: it changes only when the draft starts or stops being one.
export function useDrafted(id: string, stored: DraftSummary): boolean {
  const draft = useChatState((state) => state.draft);
  return useSyncExternalStore(draft.subscribe, () =>
    draft.chatId === id
      ? summarizeDraft(draft.value.text, draft.getPhotos().length) !== null
      : stored !== null,
  );
}

// What the open chat shows, as its runtime publishes it.
export function useOpenChat<T>(selector: (view: ChatView) => T): T {
  return useStore(
    useChatState((state) => state.open),
    selector,
  );
}

// A value of the open chat once the chats are open, `closed` until then.
export function useOpenChatView<T>(
  selector: (view: ChatView) => T,
  closed: T,
): T {
  const open = useOpenChatState((state) => state.open, null);
  return useSyncExternalStore(open?.subscribe ?? closedSubscribe, () =>
    open ? selector(open.getState()) : closed,
  );
}

// The header's model name, empty until the chats are open.
export function useOpenChatModelName() {
  const model = useOpenChatView((view) => view.chat.model.id, "");
  const catalog = useModelCatalog();
  return catalog.models.find((item) => item.id === model)?.name ?? model;
}

// The open chat's model and what it can't take.
export function useChatModel() {
  const facts = useOpenChat((view) => view.chat.model);
  return {
    model: facts.id,
    // What the chat's requests are sized within.
    budget: budgetOf(facts),
    audioIssue: facts.issues.audio,
    imageIssue: facts.issues.image,
  };
}
