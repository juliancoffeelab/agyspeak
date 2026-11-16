import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert,
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

import type { ModelSettings } from "./openRouter";
import { useRecording } from "./useRecording";
import { AttachmentMenu } from "./AttachmentMenu";
import { usePhotoAttachments } from "./usePhotoAttachments";
import { contextHasAudio, contextHasPhotos } from "./context";
import type {
  AudioInput,
  PhotoInput,
  PhotoReference,
  Message,
} from "./history";
import type { ChatColors } from "./theme";
import type { PersistentDraft } from "./PersistentDraft";
import { LiveAudioWaveform, audioTime } from "./AudioWaveform";

type Props = {
  draft: PersistentDraft;
  onOpenPhoto: (reference: PhotoReference) => void;
  messages: Message[];
  audioIssue: string | null;
  imageIssue: string | null;
  colors: ChatColors;
  visible: boolean;
  disabled: boolean;
  pending: boolean;
  onSendText: (text: string, photos?: PhotoInput[]) => Promise<boolean>;
  onStopReply: () => void;
  settings: ModelSettings;
  onSend: (audio: AudioInput, settings: ModelSettings) => Promise<boolean>;
};

export function AudioComposer({
  draft,
  onOpenPhoto,
  messages,
  audioIssue,
  imageIssue,
  colors,
  visible,
  disabled,
  pending,
  onSendText,
  onStopReply,
  settings,
  onSend,
}: Props) {
  const recording = useRecording(visible, (audio) => onSend(audio, settings));
  const images = usePhotoAttachments(visible, draft);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<TextInputInstance>(null);
  const hasText = useSyncExternalStore(
    draft.subscribe,
    () => draft.value.text.trim().length > 0,
  );
  const textNeedsAudio = useSyncExternalStore(
    draft.subscribe,
    () =>
      audioIssue !== null &&
      contextHasAudio(messages, draft.value.text, images.photos),
  );
  const textNeedsImages = useSyncExternalStore(
    draft.subscribe,
    () =>
      imageIssue !== null &&
      contextHasPhotos(messages, draft.value.text, images.photos),
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
      const photos = images.photos.length ? await images.read() : undefined;
      if (!aliveRef.current || draft.suspended || !images.isActive()) return;
      await draft.submit(
        async (text) => {
          const sent = await onSendText(text, photos);
          return sent;
        },
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
    Alert.alert("Input unavailable", message);
  }

  const capture = recording.state;
  const hasAudio = capture.phase === "recording" || capture.clip !== null;
  const canSend = hasAudio || hasText || images.photos.length > 0;
  const primaryAudioIssue = pending
    ? null
    : !canSend || hasAudio || textNeedsAudio
      ? audioIssue
      : null;
  const primaryIssue = pending
    ? null
    : (primaryAudioIssue ??
      (images.photos.length || textNeedsImages ? imageIssue : null));
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
  return (
    <View style={styles.container}>
      <AttachmentMenu
        visible={menuOpen && visible}
        colors={colors}
        audioIssue={audioIssue}
        imageIssue={imageIssue}
        onClose={() => setMenuOpen(false)}
        onChoose={(source) => {
          void run(() => chooseAttachment(source));
        }}
      />
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
      <View
        style={[
          styles.row,
          { borderColor: colors.line, backgroundColor: colors.surface },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={hasAudio ? "Discard recording" : "Add attachment"}
          disabled={blocked || pending}
          onPress={() => {
            if (hasAudio) void recording.discard();
            else {
              Keyboard.dismiss();
              setMenuOpen(true);
            }
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
          defaultValue={draft.initialText}
          editable={!draft.suspended}
          accessibilityLabel="Message"
          placeholder="Message…"
          placeholderTextColor={colors.muted}
          underlineColorAndroid="transparent"
          onChangeText={(text) => draft.edit(text)}
          multiline
          maxLength={12000}
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
          disabled={blocked}
          accessibilityHint={primaryIssue ?? undefined}
          onPress={() => {
            if (pending) onStopReply();
            else if (primaryIssue) explain(primaryIssue);
            else if (canSend) void run(send);
            else {
              Keyboard.dismiss();
              void recording.start();
            }
          }}
          style={({ pressed }) => [
            styles.primary,
            { opacity: blocked || primaryIssue ? 0.35 : pressed ? 0.6 : 1 },
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
    </View>
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    borderWidth: 1,
    borderRadius: 26,
    padding: 4,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 164,
    paddingHorizontal: 6,
    paddingVertical: 10,
    fontSize: 16,
  },
  hiddenInput: { display: "none" },
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
  error: { paddingHorizontal: 8, paddingBottom: 8, fontSize: 14 },
});
