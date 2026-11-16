import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import Check from "lucide-react-native/icons/check";
import X from "lucide-react-native/icons/x";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import { speechVoicesQuery } from "./speechVoices";
import {
  availableSpeechLanguages,
  createSpeechLanguageSearch,
} from "./speechLanguage";
import type { ChatColors } from "./theme";

export function SpeechLanguagePicker({
  colors,
  selected,
  onSelect,
  onClose,
}: {
  colors: ChatColors;
  selected: string | undefined;
  onSelect: (code: string | undefined) => void;
  onClose: () => void;
}) {
  const voices = useQuery({
    ...speechVoicesQuery,
    select: availableSpeechLanguages,
  });
  const [search, setSearch] = useState("");
  const searchLanguages = useMemo(
    () => createSpeechLanguageSearch(voices.data ?? []),
    [voices.data],
  );
  const choices = useMemo(
    () => searchLanguages(search),
    [search, searchLanguages],
  );
  function choose(code: string | undefined) {
    onSelect(code);
    onClose();
  }
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss language picker"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          style={[styles.card, { backgroundColor: colors.surface }]}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>
              Read-aloud language
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh available languages"
              disabled={voices.isFetching}
              onPress={() => {
                void voices.refetch();
              }}
              style={styles.icon}
            >
              {voices.isFetching ? (
                <ActivityIndicator color={colors.muted} />
              ) : (
                <RefreshCw size={18} color={colors.muted} />
              )}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close language picker"
              onPress={onClose}
              style={styles.icon}
            >
              <X size={22} color={colors.muted} />
            </Pressable>
          </View>
          <TextInput
            accessibilityLabel="Search speech languages"
            placeholder="Search languages"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            value={search}
            onChangeText={setSearch}
            style={[
              styles.search,
              { color: colors.text, borderColor: colors.line },
            ]}
          />
          {voices.isError && (
            <Text
              accessibilityRole="alert"
              style={[styles.error, { color: colors.text }]}
            >
              Couldn’t load voices. Tap refresh to retry.
            </Text>
          )}
          <FlatList
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            data={choices}
            keyExtractor={(item) => item.code}
            ListHeaderComponent={
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: selected === undefined }}
                onPress={() => choose(undefined)}
                style={styles.row}
              >
                <Text style={[styles.label, { color: colors.text }]}>
                  Device default
                </Text>
                {selected === undefined && (
                  <Check size={20} color={colors.text} />
                )}
              </Pressable>
            }
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityLabel={item.label}
                accessibilityState={{ checked: selected === item.code }}
                onPress={() => choose(item.code)}
                style={[
                  styles.row,
                  {
                    borderTopColor: colors.line,
                    borderTopWidth: StyleSheet.hairlineWidth,
                  },
                ]}
              >
                <View style={styles.name}>
                  <Text style={[styles.label, { color: colors.text }]}>
                    {item.label}
                  </Text>
                  <Text style={[styles.code, { color: colors.muted }]}>
                    {item.code}
                  </Text>
                </View>
                {selected === item.code && (
                  <Check size={20} color={colors.text} />
                )}
              </Pressable>
            )}
            ListEmptyComponent={
              !voices.isFetching && !voices.isError ? (
                <Text style={[styles.error, { color: colors.muted }]}>
                  No matching languages.
                </Text>
              ) : undefined
            }
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  card: {
    width: "100%",
    maxWidth: 400,
    height: 460,
    maxHeight: "85%",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingBottom: 8,
    overflow: "hidden",
  },
  header: { flexDirection: "row", alignItems: "center", paddingVertical: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: "600" },
  icon: {
    width: 40,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  search: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 15,
    marginBottom: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 54,
    paddingVertical: 10,
    gap: 12,
  },
  name: { flex: 1, gap: 2 },
  label: { fontSize: 15, flexShrink: 1 },
  code: { fontSize: 12 },
  error: { paddingVertical: 12, fontSize: 13 },
});
