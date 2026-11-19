import { useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import Bug from "lucide-react-native/icons/bug";
import Check from "lucide-react-native/icons/check";
import CircleAlert from "lucide-react-native/icons/circle-alert";
import Copy from "lucide-react-native/icons/copy";
import RotateCw from "lucide-react-native/icons/rotate-cw";
import X from "lucide-react-native/icons/x";

import { formatError } from "./formatError";
import { useColors } from "./theme";

// A failure where it happened, as one card in the danger colour: what went
// wrong, an optional line on what it means, then its actions. Retry and
// dismiss appear where the caller can do them. The bug opens the error's
// full details, which can be copied from there. The card has no outer
// margin; the region it sits in pads it like its other content.
export function Failure({
  message,
  hint,
  error,
  onRetry,
  onDismiss,
}: {
  message: string;
  hint: string | null;
  error: unknown;
  onRetry: (() => void) | null;
  onDismiss: (() => void) | null;
}) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const details = formatError(error);
  return (
    <View
      style={[
        styles.card,
        { borderColor: colors.danger, backgroundColor: colors.surface },
      ]}
    >
      <View style={styles.heading}>
        <CircleAlert size={20} color={colors.danger} />
        <Text
          accessibilityRole="alert"
          style={[styles.message, { color: colors.text }]}
        >
          {message}
        </Text>
      </View>
      {hint !== null && (
        <Text style={[styles.hint, { color: colors.muted }]}>{hint}</Text>
      )}
      <View style={styles.actions}>
        {onRetry && (
          <Action label="Try again" expanded={null} onPress={onRetry}>
            <RotateCw size={20} color={colors.text} />
          </Action>
        )}
        <Action
          label={open ? "Hide error details" : "Show error details"}
          expanded={open}
          onPress={() => setOpen((value) => !value)}
        >
          <Bug size={20} color={colors.text} />
        </Action>
        {onDismiss && (
          <Action label="Dismiss" expanded={null} onPress={onDismiss}>
            <X size={20} color={colors.text} />
          </Action>
        )}
      </View>
      {open && (
        <View style={[styles.box, { borderColor: colors.line }]}>
          <ScrollView style={styles.scroll} nestedScrollEnabled>
            <Text selectable style={[styles.text, { color: colors.muted }]}>
              {details}
            </Text>
          </ScrollView>
          <View style={[styles.copy, { borderTopColor: colors.line }]}>
            <Action
              label={copied ? "Error details copied" : "Copy error details"}
              expanded={null}
              onPress={() => {
                void Clipboard.setStringAsync(details).then(() =>
                  setCopied(true),
                );
              }}
            >
              {copied ? (
                <Check size={20} color={colors.text} />
              ) : (
                <Copy size={20} color={colors.text} />
              )}
            </Action>
          </View>
        </View>
      )}
    </View>
  );
}

function Action({
  label,
  expanded,
  onPress,
  children,
}: {
  label: string;
  // Whether what it opens is open; null for an action that opens nothing.
  expanded: boolean | null;
  onPress: () => void;
  children: ReactNode;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={expanded === null ? undefined : { expanded }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: expanded || pressed ? colors.bubble : undefined },
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 14,
    paddingTop: 14,
    paddingHorizontal: 14,
    paddingBottom: 6,
    gap: 6,
  },
  heading: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  message: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  hint: { fontSize: 14, lineHeight: 21 },
  // The touch areas are larger than the icons, which line up with the text.
  actions: { flexDirection: "row", gap: 4, marginLeft: -12 },
  action: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
  },
  box: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    marginBottom: 8,
  },
  scroll: { maxHeight: 280, padding: 12 },
  copy: {
    alignItems: "flex-end",
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  text: {
    fontSize: 12,
    lineHeight: 17,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
});
