import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import X from "lucide-react-native/icons/x";
import { useModelCatalog } from "../providers/openrouter/hooks";
import { customModelId, matchModels } from "../providers/openrouter/metadata";
import { ModelOption } from "./ModelOption";
import { useColors } from "./theme";
import { Failure } from "./Failure";
import { Overlay } from "./Overlay";
import { Screen } from "./Screen";

// Search, suggestions and selection of an OpenRouter model. The caller owns
// what the choice means and how it is saved; `onSelect` resolves once it is
// saved and rejects when it isn't, and the picker stays open to retry.
export function ModelPicker({
  title,
  selected,
  onSelect,
  onClose,
}: {
  title: string;
  selected: string;
  onSelect: (model: string) => Promise<void>;
  onClose: () => void;
}) {
  const colors = useColors();
  const catalog = useModelCatalog();
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  // Why the last choice wasn't saved.
  const [unsaved, setUnsaved] = useState<{ cause: unknown } | null>(null);
  const choices = useMemo(
    () => matchModels(catalog.models, search, selected),
    [catalog.models, search, selected],
  );
  const custom = customModelId(catalog.models, search);
  async function choose(id: string) {
    if (saving) return;
    setSaving(true);
    setUnsaved(null);
    try {
      await onSelect(id);
      onClose();
    } catch (cause) {
      setUnsaved({ cause });
    } finally {
      setSaving(false);
    }
  }
  function close() {
    if (!saving) onClose();
  }
  return (
    <Overlay placement="fill" closeLabel="Close model picker" onClose={close}>
      <Screen keyboard="pad" background={colors.background}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh model list"
            disabled={saving || catalog.loading}
            onPress={catalog.refresh}
            style={styles.icon}
          >
            {saving || catalog.loading ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <RefreshCw size={20} color={colors.text} />
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close model picker"
            disabled={saving}
            onPress={close}
            style={styles.icon}
          >
            <X size={24} color={colors.text} />
          </Pressable>
        </View>
        <TextInput
          accessibilityLabel="Search models"
          placeholder="Search models"
          placeholderTextColor={colors.muted}
          // The field owns its text; the search only follows it.
          onChangeText={setSearch}
          editable={!saving}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            styles.search,
            { color: colors.text, borderColor: colors.line },
          ]}
        />
        <FlatList
          data={choices}
          keyExtractor={(model) => model.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <ModelOption
              model={item}
              selected={item.id === selected}
              disabled={saving}
              onPress={() => {
                void choose(item.id);
              }}
            />
          )}
          ListHeaderComponent={
            custom !== null ? (
              <Pressable
                accessibilityRole="button"
                disabled={saving}
                onPress={() => {
                  void choose(custom);
                }}
                style={styles.manual}
              >
                <Text style={{ color: colors.text }}>Use {custom}</Text>
              </Pressable>
            ) : undefined
          }
          ListEmptyComponent={
            catalog.error === null ? (
              <Text style={[styles.notice, { color: colors.muted }]}>
                {catalog.loading ? "Loading models…" : "No matching models."}
              </Text>
            ) : undefined
          }
        />
        {unsaved ? (
          <View style={styles.failure}>
            <Failure
              message="Couldn’t save this model."
              hint={null}
              error={unsaved.cause}
              onRetry={null}
              onDismiss={null}
            />
          </View>
        ) : (
          catalog.error !== null && (
            <View style={styles.failure}>
              <Failure
                message={catalog.error}
                hint={null}
                error={catalog.failure}
                onRetry={null}
                onDismiss={null}
              />
            </View>
          )
        )}
      </Screen>
    </Overlay>
  );
}
const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  title: { flex: 1, fontSize: 22, fontWeight: "600" },
  icon: {
    width: 44,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  search: {
    marginHorizontal: 20,
    marginBottom: 8,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  list: { paddingHorizontal: 20, paddingBottom: 20 },
  // Below the list, so that showing it moves no row.
  failure: { paddingHorizontal: 20, paddingVertical: 8 },
  notice: { paddingHorizontal: 20, paddingVertical: 12, fontSize: 14 },
  manual: { minHeight: 52, justifyContent: "center" },
});
