import { useImperativeHandle, useRef, useState, type Ref } from "react";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { DEFAULT_SETTINGS } from "./settings";
import { ModelOption } from "./ModelOption";
import { matchModels } from "./routerMetadata";
import { useModelCatalog } from "./useRouterMetadata";
import { settingsStyles as styles } from "./settingsStyles";
import type { ChatColors } from "./theme";

export type ModelPickerHandle = { finishEditing: () => void };

export function ModelPicker({
  colors,
  label = "Model",
  initial,
  onSave,
  ref,
}: {
  colors: ChatColors;
  label?: string;
  initial: string;
  onSave: (model: string) => Promise<void>;
  ref?: Ref<ModelPickerHandle>;
}) {
  const [model, setModel] = useState(initial);
  const draftRef = useRef(initial);
  const lastSubmittedRef = useRef(initial);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [choosingModel, setChoosingModel] = useState(false);
  const catalog = useModelCatalog();
  const suggestions = matchModels(catalog.models, model);
  const selectedModel = catalog.models.find((item) => item.id === model);

  function change(value: string) {
    draftRef.current = value;
    setModel(value);
  }
  function finishModelEditing(value = draftRef.current) {
    const selected = value.trim() || DEFAULT_SETTINGS.model;
    change(selected);
    setChoosingModel(false);
    if (lastSubmittedRef.current === selected) return;
    const previous = lastSubmittedRef.current;
    lastSubmittedRef.current = selected;
    setSaveError(null);
    void onSave(selected).catch(() => {
      if (lastSubmittedRef.current === selected) {
        lastSubmittedRef.current = previous;
        setSaveError("Couldn’t save model. Finish editing to retry.");
      }
    });
  }
  useImperativeHandle(ref, () => ({
    finishEditing: () => finishModelEditing(),
  }));

  function dismissModel() {
    finishModelEditing();
    Keyboard.dismiss();
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh model list"
          disabled={catalog.loading}
          onPress={catalog.refresh}
          style={styles.iconButton}
        >
          {catalog.loading ? (
            <ActivityIndicator size="small" color={colors.muted} />
          ) : (
            <RefreshCw size={20} color={colors.muted} />
          )}
        </Pressable>
      </View>
      <TextInput
        accessibilityLabel="OpenRouter model"
        value={model}
        onChangeText={(value) => {
          change(value);
          setChoosingModel(true);
        }}
        onFocus={() => setChoosingModel(true)}
        onBlur={() => finishModelEditing()}
        onSubmitEditing={dismissModel}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Search models"
        placeholderTextColor={colors.muted}
        underlineColorAndroid="transparent"
        style={[styles.input, { color: colors.text, borderColor: colors.line }]}
      />
      {choosingModel && (
        <View>
          {suggestions.map((item) => (
            <ModelOption
              key={item.id}
              model={item}
              colors={colors}
              onPress={() => {
                finishModelEditing(item.id);
                Keyboard.dismiss();
              }}
            />
          ))}
          {suggestions.length === 0 && !catalog.loading && (
            <Text style={[styles.hint, { color: colors.muted }]}>
              {catalog.error ?? "No matches. You can still enter a model ID."}
            </Text>
          )}
        </View>
      )}
      {!choosingModel && (
        <Text
          numberOfLines={2}
          style={[styles.modelSummary, styles.hint, { color: colors.muted }]}
        >
          {saveError ??
            catalog.error ??
            (selectedModel
              ? `${selectedModel.name}${selectedModel.image ? " · Photos" : ""}${selectedModel.audio ? " · Audio" : ""}`
              : " ")}
        </Text>
      )}
    </View>
  );
}
