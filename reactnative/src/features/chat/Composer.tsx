import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Image,
  ScrollView,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputInstance,
} from "react-native";
import ArrowUp from "lucide-react-native/icons/arrow-up";
import Mic from "lucide-react-native/icons/mic";
import Plus from "lucide-react-native/icons/plus";
import Square from "lucide-react-native/icons/square";
import X from "lucide-react-native/icons/x";

import { useRecording } from "./useRecording";
import { PhotoCamera } from "./PhotoCamera";
import { AttachmentMenu } from "./AttachmentMenu";
import { usePhotoAttachments } from "./usePhotoAttachments";
import { recordingSeconds } from "./runtime/compaction";
import type {
  AudioInput,
  PhotoAttachment,
  PhotoInput,
  PhotoReference,
} from "./storage/contracts";
import { notify } from "../../ui/notice";
import { useColors } from "../../ui/theme";
import { useStore } from "zustand";
import {
  useChatScope,
  useChatModel,
  useChatState,
  useOpenChat,
} from "./chatContext";
import { refusal } from "./runtime/machine";
import type { TurnResult } from "./runtime/draft";
import type { PersistentDraft } from "./runtime/PersistentDraft";
import { LiveAudioWaveform, audioTime } from "./AudioWaveform";

// Text, photo and voice input for the open chat's draft. Each draft gets a
// fresh composer session.
// Capture runs only while the composer is active: its route is focused and
// no local dialog covers it.
function Composer({
  active,
  onOpenPhoto,
  onSent,
}: {
  active: boolean;
  onOpenPhoto: (reference: PhotoReference) => void;
  onSent: () => void;
}) {
  const { chat: commands, connection } = useChatScope();
  const draft = useChatState((state) => state.draft);
  const busy = useChatState((state) => state.busy);
  // What runs in the chat is stopped from here, a message waiting for room
  // as a reply is.
  const pending = useOpenChat((view) => refusal(view.chat, "stop") === null);
  // The chat as the send is checked against; checks are read again when it
  // changes.
  const chat = useOpenChat((view) => view.chat);
  const connected = useStore(
    connection.state,
    (state) => state.status === "ready" && state.connected,
  );
  const { audioIssue, imageIssue } = useChatModel();
  const sent = (result: TurnResult) => {
    if (result === "saved") onSent();
    return result;
  };
  return (
    <DraftComposer
      key={draft.key}
      draft={draft}
      sendIssue={(message) => (chat ? commands.sendIssue(message) : null)}
      onOpenPhoto={onOpenPhoto}
      audioIssue={audioIssue}
      imageIssue={imageIssue}
      active={active}
      disabled={busy}
      connected={connected}
      pending={pending}
      onSendText={(text, photos) => commands.send(text, photos).then(sent)}
      onStopReply={() => {
        const refused = commands.command({ kind: "stop" });
        if (refused) notify("Couldn’t stop", refused);
      }}
      onSend={(audio) => commands.sendAudio(audio).then(sent)}
    />
  );
}

// The composer's frame, mounted once with the chat layout: the draft's
// controls while its chat shows, otherwise the same row with nothing to type
// into or send yet. Switching drafts replaces only the contents of the frame.
export function ComposerRegion({
  ready,
  active,
  onOpenPhoto,
  onSent,
}: {
  ready: boolean;
  active: boolean;
  onOpenPhoto: (reference: PhotoReference) => void;
  onSent: () => void;
}) {
  const colors = useColors();
  return (
    <View style={styles.container}>
      <View
        style={[
          styles.frame,
          { borderColor: colors.line, backgroundColor: colors.surface },
        ]}
      >
        {ready ? (
          <Composer active={active} onOpenPhoto={onOpenPhoto} onSent={onSent} />
        ) : (
          <PendingControls />
        )}
      </View>
    </View>
  );
}

function PendingControls() {
  const colors = useColors();
  return (
    <View
      accessible
      accessibilityLabel="Message"
      accessibilityState={{ disabled: true }}
      style={styles.row}
    >
      <View style={[styles.iconButton, styles.unavailable]}>
        <Plus size={22} strokeWidth={2} color={colors.muted} />
      </View>
      <Text style={[styles.input, styles.placeholder, { color: colors.muted }]}>
        Message…
      </Text>
      <View style={[styles.primary, styles.unavailable]}>
        <View style={[styles.buttonFace, { backgroundColor: colors.button }]}>
          <Mic size={21} strokeWidth={2} color={colors.buttonText} />
        </View>
      </View>
    </View>
  );
}

type Props = {
  draft: PersistentDraft;
  onOpenPhoto: (reference: PhotoReference) => void;
  // Why the chat wouldn't take this message now: the machine's answer.
  sendIssue: (
    message:
      | { kind: "text"; text: string; photos: readonly PhotoAttachment[] }
      | { kind: "recording"; durationMillis: number; format: string },
  ) => string | null;
  audioIssue: string | null;
  imageIssue: string | null;
  active: boolean;
  disabled: boolean;
  // Whether a saved key is ready to send with; only sending waits for it.
  connected: boolean;
  pending: boolean;
  onSendText: (text: string, photos: PhotoInput[]) => Promise<TurnResult>;
  onStopReply: () => void;
  onSend: (audio: AudioInput) => Promise<TurnResult>;
};

function DraftComposer({
  draft,
  onOpenPhoto,
  sendIssue,
  audioIssue,
  imageIssue,
  active,
  disabled,
  connected,
  pending,
  onSendText,
  onStopReply,
  onSend,
}: Props) {
  const colors = useColors();
  const { budget } = useChatModel();
  const recording = useRecording(active, onSend);
  const images = usePhotoAttachments(active, draft);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<TextInputInstance>(null);
  // The field owns what is typed, and the draft only copies it. React Native
  // hands `defaultValue` to the native field on every render, not once, so
  // the live draft there would write the field's own text back to it a
  // moment late, which can break a word a predictive keyboard is composing
  // and lose keys. The field gets the draft as it was when this composer was
  // made; a restored draft is written to it directly.
  const [initialText] = useState(() => draft.value.text);
  const hasText = useSyncExternalStore(
    draft.subscribe,
    () => draft.value.text.trim().length > 0,
  );
  // Why the model can't take the draft as it stands, read as it is typed.
  const textIssue = useSyncExternalStore(draft.subscribe, () =>
    sendIssue({
      kind: "text",
      text: draft.value.text,
      photos: images.photos,
    }),
  );
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lockRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  // A message given back to the draft is written to the field.
  useEffect(
    () =>
      draft.onRestored((text) => inputRef.current?.setNativeProps({ text })),
    [draft],
  );

  async function run(action: () => Promise<void>) {
    if (lockRef.current) return;
    lockRef.current = true;
    setWorking(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      if (aliveRef.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Couldn’t read the attachment. Please try again.",
        );
    } finally {
      lockRef.current = false;
      if (aliveRef.current) setWorking(false);
    }
  }

  async function send() {
    if (hasAudio) await recording.send();
    else {
      const photos = images.photos.length ? await images.read() : [];
      if (!aliveRef.current || draft.suspended || !images.isActive()) return;
      await draft.submit(
        (text) => onSendText(text, photos),
        () => {
          inputRef.current?.clear();
        },
        (text) => {
          if (!aliveRef.current) return;
          inputRef.current?.setNativeProps({ text });
        },
        images.photos.length > 0,
      );
    }
  }

  function explain(message: string) {
    notify("Input unavailable", message);
  }

  const capture = recording.state;
  const hasAudio = capture.phase === "recording" || capture.clip !== null;
  const canSend = hasAudio || hasText || images.photos.length > 0;
  // With nothing typed or attached the primary button records.
  const primaryIssue = pending
    ? null
    : !canSend || hasAudio
      ? sendIssue({
          kind: "recording",
          // A recording's size is exact once its length is known.
          durationMillis:
            capture.clip?.durationMillis ?? capture.durationMillis,
          format: capture.clip?.format ?? "m4a",
        })
      : textIssue;
  async function chooseAttachment(source: "camera" | "photos" | "audio") {
    setMenuOpen(false);
    const issue = source === "audio" ? audioIssue : imageIssue;
    if (issue) {
      explain(issue);
      return;
    }
    if (source === "audio") {
      if (images.photos.length) {
        explain("Send or remove your photos before attaching audio.");
        return;
      }
      await recording.attach();
    } else await images.pick(source);
  }
  const blocked =
    disabled ||
    working ||
    images.picking ||
    capture.phase === "preparing" ||
    capture.phase === "sending";
  // A send stays in progress until its message is saved, and Stop is how
  // one that waits for room is taken back, so only `disabled` blocks Stop.
  const primaryBlocked = pending ? disabled : blocked || !connected;
  return (
    <>
      {images.cameraOpen && active && (
        <PhotoCamera
          onClose={images.closeCamera}
          onAttach={images.attachCamera}
        />
      )}

      {menuOpen && active && (
        <AttachmentMenu
          audioIssue={audioIssue}
          imageIssue={imageIssue}
          onClose={() => setMenuOpen(false)}
          onChoose={(source) => {
            void run(() => chooseAttachment(source));
          }}
        />
      )}
      {images.photos.length > 0 && (
        <ScrollView
          horizontal
          style={styles.previewStrip}
          contentContainerStyle={styles.previews}
        >
          {images.photos.map((photo, index) => (
            <View key={photo.id}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open attached photo ${index + 1}`}
                onPress={() => onOpenPhoto({ id: photo.id, draft: true })}
              >
                <Image
                  source={{ uri: `data:image/jpeg;base64,${photo.thumbnail}` }}
                  style={styles.preview}
                  accessibilityLabel={`Attached photo ${index + 1}`}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove photo ${index + 1}`}
                disabled={blocked || pending}
                onPress={() => {
                  void run(() => images.remove(photo.id));
                }}
                style={[styles.removePhoto, { backgroundColor: colors.button }]}
              >
                <X size={16} color={colors.buttonText} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      {(error ?? capture.error) !== null && (
        <Text
          accessibilityRole="alert"
          style={[styles.error, { color: colors.text }]}
        >
          {error ?? capture.error}
        </Text>
      )}
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={hasAudio ? "Discard recording" : "Add attachment"}
          disabled={blocked || pending}
          onPress={() => {
            if (hasAudio) void recording.discard();
            else setMenuOpen(true);
          }}
          style={[
            styles.iconButton,
            { opacity: blocked || pending ? 0.35 : 1 },
          ]}
        >
          {hasAudio ? (
            <X size={22} strokeWidth={2} color={colors.muted} />
          ) : (
            <Plus size={22} strokeWidth={2} color={colors.muted} />
          )}
        </Pressable>
        {hasAudio && (
          <View style={styles.recording}>
            <View style={styles.wave}>
              <LiveAudioWaveform levels={capture.levels} color={colors.text} />
            </View>
            <Text style={[styles.timer, { color: colors.muted }]}>
              {audioTime(capture.durationMillis)}
            </Text>
          </View>
        )}
        <TextInput
          ref={inputRef}
          defaultValue={initialText}
          editable={!draft.suspended}
          accessibilityLabel="Message"
          placeholder="Message…"
          placeholderTextColor={colors.muted}
          underlineColorAndroid="transparent"
          onChangeText={(text) => draft.edit(text)}
          multiline
          textAlignVertical="top"
          style={[
            styles.input,
            { color: colors.text },
            hasAudio && styles.hiddenInput,
          ]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            pending
              ? "Stop reply"
              : canSend
                ? hasAudio
                  ? "Send recording"
                  : "Send message"
                : "Record voice message"
          }
          disabled={primaryBlocked}
          accessibilityHint={primaryIssue ?? undefined}
          onPress={() => {
            if (pending) onStopReply();
            else if (primaryIssue) explain(primaryIssue);
            else if (canSend) void run(send);
            else {
              Keyboard.dismiss();
              void recording.start(recordingSeconds(budget));
            }
          }}
          style={({ pressed }) => [
            styles.primary,
            {
              opacity:
                primaryBlocked || primaryIssue ? 0.35 : pressed ? 0.6 : 1,
            },
          ]}
        >
          <View style={[styles.buttonFace, { backgroundColor: colors.button }]}>
            {pending ? (
              <Square
                size={17}
                fill={colors.buttonText}
                color={colors.buttonText}
              />
            ) : canSend ? (
              <ArrowUp size={23} strokeWidth={2.25} color={colors.buttonText} />
            ) : (
              <Mic size={21} strokeWidth={2} color={colors.buttonText} />
            )}
          </View>
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  previewStrip: { maxHeight: 108, flexGrow: 0 },
  previews: { gap: 12, paddingVertical: 8, paddingHorizontal: 4 },
  preview: { width: 88, height: 88, borderRadius: 12 },
  removePhoto: {
    position: "absolute",
    top: 0,
    right: 0,
    minWidth: 32,
    minHeight: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  container: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10 },
  frame: { borderWidth: 1, borderRadius: 26, padding: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 2 },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 164,
    paddingHorizontal: 6,
    paddingVertical: 10,
    fontSize: 16,
  },
  hiddenInput: { display: "none" },
  placeholder: { lineHeight: 24 },
  unavailable: { opacity: 0.35 },
  recording: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 48,
  },
  wave: { flex: 1, minWidth: 0 },
  primary: {
    width: 44,
    height: 48,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonFace: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButton: {
    width: 44,
    height: 48,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  timer: {
    flexShrink: 0,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
    fontSize: 14,
    lineHeight: 20,
    includeFontPadding: false,
  },
  error: { paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
});
