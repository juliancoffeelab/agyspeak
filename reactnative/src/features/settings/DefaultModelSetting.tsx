import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useStore } from "zustand";
import type { PreferencesOwner } from "../../preferences/preferences";
import { useModelCatalog } from "../../providers/openrouter/hooks";
import { Failure } from "../../ui/Failure";
import { ModelPicker } from "../../ui/ModelPicker";
import { settingsStyles as styles } from "../../ui/settingsStyles";
import { useColors } from "../../ui/theme";

// The model new chats start with. Changing it leaves existing chats alone.
export function DefaultModelSetting({
  preferences,
}: {
  preferences: PreferencesOwner;
}) {
  const colors = useColors();
  const model = useStore(preferences.state, (state) => state.defaultModel);
  const catalog = useModelCatalog();
  const [choosing, setChoosing] = useState(false);
  const selected = catalog.models.find((item) => item.id === model);
  const summary = selected
    ? `${selected.name}${selected.image ? " · Photos" : ""}${selected.audio ? " · Audio" : ""}`
    : null;
  return (
    <View style={styles.section}>
      <Text style={[styles.label, { color: colors.text }]}>Default model</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Default model: ${selected?.name ?? model}`}
        onPress={() => setChoosing(true)}
        style={[styles.input, styles.choice, { borderColor: colors.line }]}
      >
        <Text style={[styles.choiceText, { color: colors.text }]}>{model}</Text>
      </Pressable>
      {summary !== null && (
        <Text style={[styles.hint, { color: colors.muted }]}>{summary}</Text>
      )}
      {!selected && catalog.error !== null && (
        <Failure
          message={catalog.error}
          hint={null}
          error={catalog.failure}
          onRetry={null}
          onDismiss={null}
        />
      )}
      {choosing && (
        <ModelPicker
          title="Default model"
          selected={model}
          onSelect={(id) => preferences.saveDefaultModel(id)}
          onClose={() => setChoosing(false)}
        />
      )}
    </View>
  );
}
