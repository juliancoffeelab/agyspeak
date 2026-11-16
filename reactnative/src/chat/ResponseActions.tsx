import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import Copy from "lucide-react-native/icons/copy";
import Check from "lucide-react-native/icons/check";
import Volume2 from "lucide-react-native/icons/volume-2";
import Languages from "lucide-react-native/icons/languages";
import { speechLanguageLabel } from "./speechLanguage";
import { SpeechLanguagePicker } from "./SpeechLanguagePicker";
import Square from "lucide-react-native/icons/square";
import { replySpeech } from "./replySpeech";
import type { ChatColors } from "./theme";

export const ResponseActions = memo(function ResponseActions({
  id,
  markdown,
  elapsedMillis,
  colors,
}: {
  id: number;
  markdown: string;
  elapsedMillis?: number | null;
  colors: ChatColors;
}) {
  const speaking = useSyncExternalStore(
    replySpeech.subscribe,
    () => replySpeech.getSnapshot().messageId === id,
  );
  const recording = useSyncExternalStore(
    replySpeech.subscribe,
    () => replySpeech.getSnapshot().recording,
  );
  const language = useSyncExternalStore(replySpeech.subscribe, () =>
    replySpeech.getSnapshot().languages.get(id),
  );
  const selectedLabel = language
    ? speechLanguageLabel(language)
    : "Device default";
  const [pickerId, setPickerId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copied = copiedId === id;
  const aliveRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);
  async function copy() {
    try {
      await Clipboard.setStringAsync(markdown);
      if (!aliveRef.current) return;
      setCopiedId(id);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopiedId(null), 1800);
    } catch {
      Alert.alert("Couldn’t copy the response.");
    }
  }
  return (
    <View style={styles.row}>
      {pickerId === id && (
        <SpeechLanguagePicker
          colors={colors}
          selected={language}
          onSelect={(code) => replySpeech.setLanguage(id, code)}
          onClose={() => setPickerId(null)}
        />
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          speaking ? "Stop reading response" : "Read response aloud"
        }
        disabled={recording}
        onPress={() => {
          if (speaking) void replySpeech.stop();
          else void replySpeech.toggle(id, markdown);
        }}
        style={[styles.button, { opacity: recording ? 0.35 : 1 }]}
      >
        {speaking ? (
          <Square size={16} color={colors.muted} />
        ) : (
          <Volume2 size={18} color={colors.muted} />
        )}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Read-aloud language: ${selectedLabel}`}
        onPress={() => setPickerId(id)}
        style={styles.button}
      >
        {language ? (
          <Text style={[styles.language, { color: colors.muted }]}>
            {language.split("-")[0].toUpperCase()}
          </Text>
        ) : (
          <Languages size={18} color={colors.muted} />
        )}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copied ? "Response copied" : "Copy response"}
        onPress={() => {
          void copy();
        }}
        style={styles.button}
      >
        {copied ? (
          <Check size={18} color={colors.muted} />
        ) : (
          <Copy size={18} color={colors.muted} />
        )}
      </Pressable>
      {elapsedMillis != null && (
        <Text
          accessibilityLabel={`Response time ${(elapsedMillis / 1000).toFixed(1)} seconds`}
          style={[styles.time, { color: colors.muted }]}
        >
          {(elapsedMillis / 1000).toFixed(1)}s
        </Text>
      )}
    </View>
  );
});
const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", marginTop: 6 },
  button: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  language: { fontSize: 12, fontWeight: "600" },
  time: { fontSize: 12, marginLeft: 8, fontVariant: ["tabular-nums"] },
});
