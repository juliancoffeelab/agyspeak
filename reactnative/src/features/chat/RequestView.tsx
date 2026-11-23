import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import Check from "lucide-react-native/icons/check";
import Copy from "lucide-react-native/icons/copy";
import Mic from "lucide-react-native/icons/mic";
import X from "lucide-react-native/icons/x";

import {
  requestTranscript,
  shownRequest,
  type ShownMessage,
  type ShownPart,
} from "./runtime/requestView";
import type { ProviderMessage } from "../../providers/openrouter/transport";
import { Failure } from "../../ui/Failure";
import { notify } from "../../ui/notice";
import { Overlay } from "../../ui/Overlay";
import { Screen } from "../../ui/Screen";
import { useColors } from "../../ui/theme";

// Messages exactly as a request sends them (see `shownRequest`), message by
// message with its role, its text verbatim and its media by size. They are
// read with their media as the view opens; `id` names what `load` reads.
export function RequestView({
  id,
  load,
  onClose,
}: {
  id: readonly unknown[];
  load: () => Promise<ProviderMessage[]>;
  onClose: () => void;
}) {
  const colors = useColors();
  const [copied, setCopied] = useState(false);
  const request = useQuery({
    queryKey: ["request", ...id],
    queryFn: async () => shownRequest(await load()),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const messages = request.data ?? null;
  return (
    <Overlay placement="fill" closeLabel="Close messages" onClose={onClose}>
      <Screen keyboard="pad" background={colors.background}>
        <View style={[styles.header, { borderBottomColor: colors.line }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close messages"
            onPress={onClose}
            style={styles.icon}
          >
            <X size={24} color={colors.text} />
          </Pressable>
          <View style={styles.fill} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copied ? "Copied messages" : "Copy messages"}
            disabled={messages === null}
            onPress={() => {
              if (messages === null) return;
              void Clipboard.setStringAsync(requestTranscript(messages)).then(
                () => setCopied(true),
                () => notify("Couldn’t copy the messages.", null),
              );
            }}
            style={[styles.icon, { opacity: messages === null ? 0.35 : 1 }]}
          >
            {copied ? (
              <Check size={22} color={colors.text} />
            ) : (
              <Copy size={22} color={colors.text} />
            )}
          </Pressable>
        </View>
        {request.isError ? (
          <View style={styles.list}>
            <Failure
              message="Couldn’t read these messages."
              hint={null}
              error={request.error}
              onRetry={() => void request.refetch()}
              onDismiss={null}
            />
          </View>
        ) : messages === null ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.muted} />
          </View>
        ) : (
          <FlatList
            data={messages}
            keyExtractor={(_, index) => String(index)}
            initialNumToRender={8}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => <ShownEntry message={item} />}
          />
        )}
      </Screen>
    </Overlay>
  );
}

function ShownEntry({ message }: { message: ShownMessage }) {
  const colors = useColors();
  return (
    <View style={[styles.entry, { borderColor: colors.line }]}>
      <Text style={[styles.role, { color: colors.muted }]}>{message.role}</Text>
      {/* A part's place in the message is what it is; parts never move. */}
      {Array.from(message.parts, (part, index) => (
        <ShownContent key={index} part={part} />
      ))}
    </View>
  );
}

function ShownContent({ part }: { part: ShownPart }) {
  const colors = useColors();
  if (part.kind === "text")
    return part.text ? (
      <Text selectable style={[styles.text, { color: colors.text }]}>
        {part.text}
      </Text>
    ) : (
      <View
        accessible
        accessibilityLabel="Empty text"
        style={[styles.empty, { borderColor: colors.line }]}
      />
    );
  if (part.kind === "photo")
    return (
      <View style={styles.media}>
        <Image
          accessibilityLabel="Photo"
          source={{ uri: part.url }}
          resizeMode="cover"
          style={[styles.thumbnail, { backgroundColor: colors.bubble }]}
        />
        <Text style={[styles.meta, { color: colors.muted }]}>
          JPEG · {size(part.bytes)}
        </Text>
      </View>
    );
  return (
    <View style={styles.media}>
      <View
        style={[
          styles.thumbnail,
          styles.center,
          { backgroundColor: colors.bubble },
        ]}
      >
        <Mic size={20} color={colors.muted} />
      </View>
      <Text style={[styles.meta, { color: colors.muted }]}>
        {part.format.toUpperCase()} · {size(part.bytes)}
      </Text>
    </View>
  );
}

function size(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    height: 56,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  icon: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: 16, gap: 12 },
  entry: {
    gap: 8,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  role: { fontSize: 12, fontWeight: "600", letterSpacing: 0.4 },
  // Plain text as sent, in a fixed-width face so spacing reads as it is.
  text: {
    fontSize: 14,
    lineHeight: 20,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
  },
  empty: {
    height: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
    borderRadius: 4,
  },
  media: { flexDirection: "row", alignItems: "center", gap: 12 },
  thumbnail: { width: 64, height: 64, borderRadius: 8 },
  meta: { fontSize: 13 },
});
