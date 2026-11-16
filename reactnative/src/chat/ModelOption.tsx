import { Pressable, StyleSheet, Text, View } from "react-native";
import Check from "lucide-react-native/icons/check";
import { modelPrice, type RouterModel } from "./routerMetadata";
import type { ChatColors } from "./theme";

export function ModelOption({
  model,
  colors,
  selected = false,
  disabled = false,
  onPress,
}: {
  model: RouterModel;
  colors: ChatColors;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Select ${model.name}`}
      accessibilityState={{ selected }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.row,
        { borderBottomColor: colors.line, opacity: disabled ? 0.5 : 1 },
      ]}
    >
      <View style={styles.details}>
        <Text numberOfLines={1} style={[styles.name, { color: colors.text }]}>
          {model.name}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.caption, { color: colors.muted }]}
        >
          {model.id}
        </Text>
        <Text style={[styles.caption, { color: colors.muted }]}>
          {modelPrice(model)}
        </Text>
        {(model.image || model.audio) && (
          <Text style={[styles.caption, { color: colors.muted }]}>
            {[model.image && "Photos", model.audio && "Audio"]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        )}
      </View>
      {selected && <Check size={20} color={colors.text} />}
    </Pressable>
  );
}
const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 72,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  details: { flex: 1, gap: 3 },
  name: { fontSize: 15 },
  caption: { fontSize: 12 },
});
