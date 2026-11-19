import { Pressable, StyleSheet, Text, View } from "react-native";
import X from "lucide-react-native/icons/x";

import { useColors } from "./theme";

// A notice that floats over the top of the region it is rendered in, instead
// of taking space from it and moving what is below.
export function Toast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.toast,
        { borderColor: colors.line, backgroundColor: colors.surface },
      ]}
    >
      <Text
        accessibilityRole="alert"
        style={[styles.text, { color: colors.text }]}
      >
        {message}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss message"
        onPress={onDismiss}
        style={styles.dismiss}
      >
        <X size={20} color={colors.muted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    top: 8,
    left: 12,
    right: 12,
    zIndex: 1,
    elevation: 3,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
  },
  text: {
    flex: 1,
    paddingHorizontal: 20,
    paddingVertical: 12,
    fontSize: 14,
    lineHeight: 21,
  },
  dismiss: {
    minHeight: 48,
    minWidth: 48,
    alignItems: "center",
    justifyContent: "center",
  },
});
