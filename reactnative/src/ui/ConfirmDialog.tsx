import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useStore } from "zustand";

import { acknowledgeNotice, notices } from "./notice";
import { Overlay } from "./Overlay";
import { useColors } from "./theme";

// A dialog's card: what it says, then its choices as text buttons at the
// trailing edge. Dismissing it in any way (the backdrop, the back button) is
// `onClose`, which `closeLabel` names.
function Dialog({
  title,
  message,
  closeLabel,
  onClose,
  children,
}: {
  title: string;
  message: string | null;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const colors = useColors();
  return (
    <Overlay placement="center" closeLabel={closeLabel} onClose={onClose}>
      <View accessibilityRole="alert" style={styles.card}>
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        {message !== null && (
          <Text style={[styles.message, { color: colors.muted }]}>
            {message}
          </Text>
        )}
        <View style={styles.actions}>{children}</View>
      </View>
    </Overlay>
  );
}

function Choice({
  label,
  color,
  onPress,
}: {
  label: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={styles.action}
    >
      <Text style={[styles.label, { color }]}>{label}</Text>
    </Pressable>
  );
}

// Asks before an action that discards something. Dismissing it is
// `onCancel`. The confirming choice comes last; `danger` colours a
// confirmation that loses something the person can't get back from the app.
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
    <Dialog
      title={title}
      message={message}
      closeLabel={cancelLabel}
      onClose={onCancel}
    >
      <Choice label={cancelLabel} color={colors.muted} onPress={onCancel} />
      <Choice
        label={confirmLabel}
        color={tone === "danger" ? colors.danger : colors.text}
        onPress={onConfirm}
      />
    </Dialog>
  );
}

// Shows the oldest notice waiting to be acknowledged. Mounted once.
export function NoticeDialog() {
  const colors = useColors();
  const notice = useStore(notices, (waiting) => waiting.at(0));
  if (!notice) return null;
  return (
    <Dialog
      title={notice.title}
      message={notice.message}
      closeLabel="OK"
      onClose={acknowledgeNotice}
    >
      <Choice label="OK" color={colors.text} onPress={acknowledgeNotice} />
    </Dialog>
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
