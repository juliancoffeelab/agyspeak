import { useEffect, useRef, useState } from "react";
import {
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
import type { AudioInput } from "./history";
import type { ChatColors } from "./theme";
import type { PersistentDraft } from "./PersistentDraft";
import { LiveAudioWaveform, audioTime } from "./AudioWaveform";

type Props = {
  draft: PersistentDraft;
  colors: ChatColors;
  visible: boolean;
  disabled: boolean;
  pending: boolean;
  onSendText: (text: string) => Promise<boolean>;
  onStopReply: () => void;
  settings: ModelSettings;
  onSend: (audio: AudioInput, settings: ModelSettings) => Promise<boolean>;
};

export function AudioComposer({
  draft,
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
  const inputRef = useRef<TextInputInstance>(null);
  const [hasText, setHasText] = useState(
    () => draft.value.text.trim().length > 0,
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
            : "Couldn’t read audio. Please try again.",
        );
    } finally {
      lockRef.current = false;
      if (aliveRef.current) setWorking(false);
    }
  }

  async function send() {
    if (hasAudio) await recording.send();
    else
      await draft.submit(
        onSendText,
        () => {
          inputRef.current?.clear();
          setHasText(false);
        },
        (text) => {
          if (!aliveRef.current) return;
          inputRef.current?.setNativeProps({ text });
          setHasText(text.trim().length > 0);
        },
      );
  }

  function changeDraft(text: string) {
    draft.edit(text);
    const nextHasText = text.trim().length > 0;
    if (nextHasText !== hasText) setHasText(nextHasText);
  }

  const capture = recording.state;
  const hasAudio = capture.phase === "recording" || capture.clip !== null;
  const canSend = hasAudio || hasText;
  const blocked =
    disabled ||
    working ||
    capture.phase === "preparing" ||
    capture.phase === "sending";
  return (
    <View style={styles.container}>
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
          accessibilityLabel={
            hasAudio ? "Discard recording" : "Attach audio file"
          }
          disabled={blocked || pending}
          onPress={() => {
            void (hasAudio ? recording.discard() : recording.attach());
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
          onChangeText={changeDraft}
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
          onPress={() => {
            if (pending) onStopReply();
            else if (canSend) void run(send);
            else {
              Keyboard.dismiss();
              void recording.start();
            }
          }}
          style={({ pressed }) => [
            styles.primary,
            { opacity: blocked ? 0.35 : pressed ? 0.6 : 1 },
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
