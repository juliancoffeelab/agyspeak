import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Check from "lucide-react-native/icons/check";
import X from "lucide-react-native/icons/x";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import { speechVoicesQuery } from "../device/speech/voices";
import {
  availableSpeechLanguages,
  createSpeechLanguageSearch,
} from "../device/speech/language";
import { Failure } from "./Failure";
import { Overlay } from "./Overlay";
import { useColors } from "./theme";

// `unsetLabel` names what no selection means where the picker is used.
export function SpeechLanguagePicker({
  selected,
  unsetLabel,
  onSelect,
  onClose,
}: {
  // Null is no selection: what `unsetLabel` names.
  selected: string | null;
  unsetLabel: string;
  onSelect: (code: string | null) => void;
  onClose: () => void;
}) {
  const colors = useColors();
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
  function choose(code: string | null) {
    onSelect(code);
    onClose();
  }
  return (
    <Overlay
      placement="center"
      closeLabel="Dismiss language picker"
      onClose={onClose}
    >
      <View style={styles.card}>
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
          // The field owns its text; the search only follows it.
          onChangeText={setSearch}
          style={[
            styles.search,
            { color: colors.text, borderColor: colors.line },
          ]}
        />
        {voices.isError && (
          <Failure
            message="Couldn’t load voices."
            hint={null}
            error={voices.error}
            onRetry={() => void voices.refetch()}
            onDismiss={null}
          />
        )}
        <FlatList
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          data={choices}
          keyExtractor={(item) => item.code}
          ListHeaderComponent={
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: selected === null }}
              onPress={() => choose(null)}
              style={styles.row}
            >
              <Text style={[styles.label, { color: colors.text }]}>
                {unsetLabel}
              </Text>
              {selected === null && <Check size={20} color={colors.text} />}
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
    </Overlay>
  );
}
const styles = StyleSheet.create({
  // Its full height where there is room, less above the keyboard.
  card: { height: 460, flexShrink: 1, paddingHorizontal: 16, paddingBottom: 8 },
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
