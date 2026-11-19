import { Pressable, StyleSheet, Text, View } from "react-native";

import { Overlay } from "./Overlay";
import { useColors } from "./theme";

// Asks before an action that discards something. Dismissing it in any way
// (the cancel choice, the backdrop, the back button) is `onCancel`. The
// choices are text buttons at the trailing edge, confirming one last;
// `danger` colours a confirmation that loses something the person can't
// get back from the app.
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: "neutral" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const colors = useColors();
  return (
    <Overlay placement="center" closeLabel={cancelLabel} onClose={onCancel}>
      <View accessibilityRole="alert" style={styles.card}>
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.message, { color: colors.muted }]}>{message}</Text>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            onPress={onCancel}
            style={styles.action}
          >
            <Text style={[styles.label, { color: colors.muted }]}>
              {cancelLabel}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={onConfirm}
            style={styles.action}
          >
            <Text
              style={[
                styles.label,
                { color: tone === "danger" ? colors.danger : colors.text },
              ]}
            >
              {confirmLabel}
            </Text>
          </Pressable>
        </View>
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingTop: 24,
    paddingHorizontal: 24,
    paddingBottom: 12,
    gap: 12,
  },
  title: { fontSize: 20, fontWeight: "600" },
  message: { fontSize: 15, lineHeight: 22 },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 8,
    // Text buttons align by their labels, not their touch areas.
    marginRight: -12,
  },
  action: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  label: { fontSize: 15, fontWeight: "600" },
});
