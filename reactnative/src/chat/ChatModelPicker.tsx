import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import X from "lucide-react-native/icons/x";
import { useModelCatalog } from "./useRouterMetadata";
import { ModelOption } from "./ModelOption";
import type { ChatColors } from "./theme";

export function ChatModelPicker({
  colors,
  selected,
  onSelect,
  onClose,
}: {
  colors: ChatColors;
  selected: string;
  onSelect: (model: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const catalog = useModelCatalog();
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/);
    return catalog.models
      .filter((model) =>
        terms.every((term) =>
          `${model.id} ${model.name}`.toLowerCase().includes(term),
        ),
      )
      .sort((a, b) => Number(b.id === selected) - Number(a.id === selected));
  }, [catalog.models, search, selected]);
  const manualId = search.trim();
  const custom =
    /^[^\s/]+\/[^\s]+$/.test(manualId) &&
    !catalog.models.some((model) => model.id === manualId);
  async function choose(id: string) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      if (await onSelect(id)) onClose();
      else setError("Couldn’t save this model. Try again.");
    } catch {
      setError("Couldn’t save this model. Try again.");
    } finally {
      setSaving(false);
    }
  }
  function close() {
    if (!saving) onClose();
  }
  return (
    <Modal animationType="slide" onRequestClose={close}>
      <SafeAreaProvider>
        <KeyboardAvoidingView
          style={[styles.screen, { backgroundColor: colors.background }]}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <SafeAreaView style={styles.screen}>
            <View style={styles.header}>
              <Text style={[styles.title, { color: colors.text }]}>Model</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Refresh model list"
                disabled={saving || catalog.loading}
                onPress={catalog.refresh}
                style={styles.icon}
              >
                {catalog.loading ? (
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
              accessibilityLabel="Search chat models"
              placeholder="Search models"
              placeholderTextColor={colors.muted}
              value={search}
              onChangeText={setSearch}
              editable={!saving}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.search,
                { color: colors.text, borderColor: colors.line },
              ]}
            />
            {(error ?? catalog.error) && (
              <Text
                accessibilityRole="alert"
                style={[styles.notice, { color: colors.text }]}
              >
                {error ?? catalog.error}
              </Text>
            )}
            {saving && <ActivityIndicator color={colors.text} />}
            <FlatList
              data={choices}
              keyExtractor={(model) => model.id}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              contentContainerStyle={styles.list}
              renderItem={({ item }) => (
                <ModelOption
                  model={item}
                  colors={colors}
                  selected={item.id === selected}
                  disabled={saving}
                  onPress={() => {
                    void choose(item.id);
                  }}
                />
              )}
              ListHeaderComponent={
                custom ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={saving}
                    onPress={() => {
                      void choose(manualId);
                    }}
                    style={styles.manual}
                  >
                    <Text style={{ color: colors.text }}>Use {manualId}</Text>
                  </Pressable>
                ) : undefined
              }
              ListEmptyComponent={
                <Text style={[styles.notice, { color: colors.muted }]}>
                  {catalog.loading ? "Loading models…" : "No matching models."}
                </Text>
              }
            />
          </SafeAreaView>
        </KeyboardAvoidingView>
      </SafeAreaProvider>
    </Modal>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1 },
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
  notice: { paddingHorizontal: 20, paddingVertical: 12, fontSize: 14 },
  manual: { minHeight: 52, justifyContent: "center" },
});
