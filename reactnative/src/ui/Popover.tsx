import { useState, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Overlay } from "./Overlay";
import { useColors } from "./theme";

// Where on the window a popover's button is, as `measureInWindow` reports it.
export type Anchor = { x: number; y: number; width: number; height: number };

// The room kept between the card and its button, and the window's edges.
const GAP = 4;
const EDGE = 8;
const WIDTH = 260;

// A small card next to the button that opened it: below it, or above when
// there isn't room, kept within the window. It appears and goes at once: a
// fade shows the card's shadow through it on Android. It claims the screen
// as an overlay does: a press anywhere else or the back button closes it,
// which `closeLabel` names.
export function Popover({
  anchor,
  closeLabel,
  onClose,
  children,
}: {
  anchor: Anchor;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  // The card is placed once its height is known; until then it is unseen.
  const [height, setHeight] = useState<number | null>(null);
  const width = Math.min(WIDTH, window.width - 2 * EDGE);
  const left = Math.max(
    insets.left + EDGE,
    Math.min(
      // Its trailing edge meets the button's, as a menu opens from it.
      anchor.x + anchor.width - width,
      window.width - insets.right - EDGE - width,
    ),
  );
  const below = anchor.y + anchor.height + GAP;
  const bottom = window.height - insets.bottom - EDGE;
  const top =
    height === null || below + height <= bottom
      ? below
      : Math.max(insets.top + EDGE, anchor.y - GAP - height);
  return (
    <Overlay placement="popover" closeLabel={closeLabel} onClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      />
      <View
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        style={[
          styles.card,
          {
            top,
            left,
            width,
            maxHeight: bottom - insets.top - EDGE,
            opacity: height === null ? 0 : 1,
            backgroundColor: colors.surface,
            borderColor: colors.line,
          },
        ]}
      >
        {children}
      </View>
    </Overlay>
  );
}

// A line of what the popover tells, in the muted colour, after its icon.
export function PopoverInfo({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  // What the line says, for screen readers.
  label: string;
  children: string;
}) {
  const colors = useColors();
  return (
    <View accessible accessibilityLabel={label} style={styles.info}>
      {icon}
      <Text style={[styles.infoText, { color: colors.muted }]}>{children}</Text>
    </View>
  );
}

export function PopoverDivider() {
  const colors = useColors();
  return <View style={[styles.divider, { backgroundColor: colors.line }]} />;
}

// One of the popover's actions. A `dimmed` action can be pressed but says,
// when it is, why it doesn't apply now.
export function PopoverAction({
  icon,
  label,
  hint,
  disabled,
  dimmed,
  onPress,
}: {
  icon: ReactNode;
  label: string;
  hint: string | null;
  disabled: boolean;
  dimmed: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={hint ?? undefined}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        {
          opacity: disabled || dimmed ? 0.35 : 1,
          backgroundColor: pressed ? colors.bubble : undefined,
        },
      ]}
    >
      {icon}
      <Text style={[styles.actionText, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
    overflow: "hidden",
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  info: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 30,
    paddingHorizontal: 14,
  },
  infoText: { flex: 1, fontSize: 13, fontVariant: ["tabular-nums"] },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 6,
  },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 14,
  },
  actionText: { fontSize: 15 },
});
