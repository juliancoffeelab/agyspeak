import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import ListCollapse from "lucide-react-native/icons/list-collapse";

import { RequestView } from "./RequestView";
import type { ProviderMessage } from "../../providers/openrouter/transport";
import { Failure } from "../../ui/Failure";
import { useColors } from "../../ui/theme";

// What a compaction marker stands for at its place: the compaction made
// there, which opens everything the model is given from there until the
// next compaction (`current` while it is the latest), read by `load`; or
// the compaction being made there, or that failed there.
export type CompactionMark =
  | {
      status: "held";
      current: boolean;
      id: readonly unknown[];
      load: () => Promise<ProviderMessage[]>;
    }
  | { status: "running" }
  | {
      status: "failed";
      message: string;
      error: unknown;
      // Null when retrying can't help.
      onCompact: (() => void) | null;
    };

// A line across the conversation where a compaction put, or will put, what
// the model is given in place of what it covers; a failed one is a failure
// card there instead. Every
// state but the failure is one line of the same height, so they change in
// place.
export function CompactionMarker({ mark }: { mark: CompactionMark }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const muted = colors.muted;
  // A failure is the app's failure card, in place, with its retry under it.
  if (mark.status === "failed")
    return (
      <View style={styles.failure}>
        <Failure
          message={mark.message}
          hint={null}
          error={mark.error}
          onRetry={mark.onCompact}
          onDismiss={null}
        />
      </View>
    );
  return (
    <View style={styles.marker}>
      <View style={[styles.rule, { backgroundColor: colors.line }]} />
      {mark.status === "held" ? (
        <Chip
          label="Earlier messages summarised"
          hint={heldHint(mark.current)}
          onPress={() => setOpen(true)}
        >
          <ListCollapse size={16} color={muted} />
        </Chip>
      ) : (
        <View
          accessible
          accessibilityLabel="Compacting older messages"
          style={styles.chip}
        >
          <ActivityIndicator size="small" color={muted} />
          <Text style={[styles.label, { color: muted }]}>
            Summarising the conversation to make room…
          </Text>
        </View>
      )}
      <View style={[styles.rule, { backgroundColor: colors.line }]} />
      {open && mark.status === "held" && (
        <RequestView
          id={mark.id}
          load={mark.load}
          onClose={() => setOpen(false)}
        />
      )}
    </View>
  );
}

function heldHint(current: boolean) {
  return current
    ? "Shows what the model is given from here"
    : "Shows what the model was given from here";
}

function Chip({
  label,
  hint,
  onPress,
  children,
}: {
  label: string;
  hint: string;
  onPress: () => void;
  children: ReactNode;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        styles.pressable,
        { borderColor: colors.line },
        pressed && { backgroundColor: colors.bubble },
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // One height for every state but the failure.
  marker: {
    flexDirection: "row",
    alignItems: "center",
    height: 44,
    marginTop: 24,
    gap: 8,
  },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    height: 36,
    gap: 8,
    paddingHorizontal: 12,
  },
  pressable: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
  },
  label: { fontSize: 13, flexShrink: 1 },
  // As far from the reply as the marker line.
  failure: { marginTop: 24 },
});
