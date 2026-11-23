import { useRef, useState } from "react";
import { useStore } from "zustand";
import * as Clipboard from "expo-clipboard";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputInstance,
} from "react-native";
import { KeyScanner } from "./KeyScanner";
import { dollars } from "../../providers/openrouter/metadata";
import { parseKeyInput } from "../../providers/openrouter/key";
import { useRouterUsage } from "../../providers/openrouter/hooks";
import { settingsStyles as styles } from "../../ui/settingsStyles";
import { useColors } from "../../ui/theme";
import type { OpenRouterConnection } from "../../connections/openrouter";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Failure } from "../../ui/Failure";

// The key editor and spending. It has its final layout while the saved key
// is still being read, with nothing to edit yet; a failed read shows in its
// place with a way to read again.
export function OpenRouterSection({
  connection,
}: {
  connection: OpenRouterConnection;
}) {
  const colors = useColors();
  const key = useStore(connection.state);
  if (key.status !== "failed")
    return (
      // The editor starts over from the key once it is read.
      <KeyEditor
        key={key.status}
        connection={connection}
        ready={key.status === "ready"}
      />
    );
  return (
    <View
      style={[
        styles.section,
        styles.routerSection,
        { borderTopColor: colors.line },
      ]}
    >
      <View style={styles.sectionHeading}>
        <Text style={[styles.label, { color: colors.text }]}>OpenRouter</Text>
      </View>
      <Failure
        message="Couldn’t read the saved key."
        hint={null}
        error={key.failure}
        onRetry={() => void connection.reload()}
        onDismiss={null}
      />
    </View>
  );
}

function KeyEditor({
  connection,
  ready,
}: {
  connection: OpenRouterConnection;
  // Whether the saved key is read; until then nothing can be edited.
  ready: boolean;
}) {
  const colors = useColors();
  // Rerender on credential replacement so the saved key below is current.
  useStore(connection.state);
  const savedKey = ready ? connection.readForEditing() : "";
  const [apiKey, setApiKey] = useState(savedKey);
  // The field owns what is typed, and `apiKey` only copies it: React Native
  // hands a field's `value` and `defaultValue` to it on every render, so a
  // changing one writes the text back while it is typed and loses keys. The
  // field starts from the key as this editor first read it, and a key put in
  // it later is written to it directly.
  const [initialKey] = useState(savedKey);
  const inputRef = useRef<TextInputInstance>(null);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  // The key, or "" for none, awaiting confirmation to replace the saved one.
  const [replacement, setReplacement] = useState<string | null>(null);
  const spending = useRouterUsage(connection);
  const canRestore =
    Boolean(savedKey) && !saving && (apiKey !== savedKey || keyError !== null);
  const status =
    keyError ??
    (spending.state === "invalid"
      ? "Invalid saved key"
      : spending.error
        ? "Spending refresh failed"
        : "");

  function acceptKey(key: string) {
    setApiKey(key);
    inputRef.current?.setNativeProps({ text: key });
    setKeyError(null);
  }
  async function paste() {
    try {
      acceptKey(parseKeyInput(await Clipboard.getStringAsync()));
    } catch {
      setKeyError("Copy an OpenRouter key first");
    }
  }

  // Replacing or removing a saved key is confirmed first.
  function save() {
    if (saving) return;
    let next: string;
    try {
      next = apiKey.trim() ? parseKeyInput(apiKey) : "";
    } catch {
      setKeyError("Invalid key");
      return;
    }
    Keyboard.dismiss();
    if (next === savedKey) acceptKey(savedKey);
    else if (savedKey) setReplacement(next);
    else void store(next);
  }
  async function store(next: string) {
    setSaving(true);
    try {
      await connection.save(next);
      acceptKey(next);
    } catch {
      setKeyError("Couldn’t save key. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <View
      style={[
        styles.section,
        styles.routerSection,
        { borderTopColor: colors.line },
      ]}
    >
      <View style={styles.sectionHeading}>
        <Text style={[styles.label, { color: colors.text }]}>OpenRouter</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh OpenRouter spending"
          accessibilityState={{ busy: spending.loading }}
          disabled={spending.loading || !spending.canRefresh}
          onPress={spending.refresh}
          style={styles.iconButton}
        >
          {spending.loading || !ready ? (
            <ActivityIndicator size="small" color={colors.muted} />
          ) : (
            <RefreshCw
              size={20}
              color={colors.muted}
              style={{ opacity: spending.canRefresh ? 1 : 0.35 }}
            />
          )}
        </Pressable>
      </View>
      <View
        style={styles.metrics}
        accessibilityLabel={`OpenRouter spending: ${spending.state}`}
      >
        <View style={styles.metric}>
          <Text
            numberOfLines={1}
            style={[styles.hint, { color: colors.muted }]}
          >
            {spending.usage?.accountBalance ? "Remaining" : "Key remaining"}
          </Text>
          <Text style={[styles.amount, { color: colors.text }]}>
            {spending.usage
              ? spending.usage.remaining === null
                ? "No cap"
                : dollars(spending.usage.remaining)
              : "—"}
          </Text>
        </View>
        <View style={styles.metric}>
          <Text style={[styles.hint, { color: colors.muted }]}>Today</Text>
          <Text style={[styles.amount, { color: colors.text }]}>
            {spending.usage ? dollars(spending.usage.daily) : "—"}
          </Text>
        </View>
        <View style={styles.metric}>
          <Text style={[styles.hint, { color: colors.muted }]}>This month</Text>
          <Text style={[styles.amount, { color: colors.text }]}>
            {spending.usage ? dollars(spending.usage.monthly) : "—"}
          </Text>
        </View>
      </View>
      <View style={styles.fieldHeading}>
        <Text style={[styles.fieldLabel, { color: colors.text }]}>API key</Text>
        <Text
          accessibilityRole={status ? "alert" : undefined}
          accessibilityLabel={spending.error ?? status}
          numberOfLines={1}
          style={[styles.spendError, { color: colors.muted }]}
        >
          {status}
        </Text>
      </View>
      <TextInput
        ref={inputRef}
        accessibilityLabel="OpenRouter API key"
        defaultValue={initialKey}
        onChangeText={(value) => {
          setApiKey(value);
          setKeyError(null);
        }}
        onSubmitEditing={() => Keyboard.dismiss()}
        editable={ready}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="API key"
        placeholderTextColor={colors.muted}
        underlineColorAndroid="transparent"
        style={[styles.input, { color: colors.text, borderColor: colors.line }]}
      />
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={!ready}
          onPress={() => {
            void paste();
          }}
          style={[styles.action, { opacity: ready ? 1 : 0.4 }]}
        >
          <Text style={{ color: colors.text }}>Paste key</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!ready}
          onPress={() => setScanning(true)}
          style={[styles.action, { opacity: ready ? 1 : 0.4 }]}
        >
          <Text style={{ color: colors.text }}>Scan QR</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Restore saved API key"
          disabled={!canRestore}
          onPress={() => acceptKey(savedKey)}
          style={[styles.action, { opacity: canRestore ? 1 : 0.4 }]}
        >
          <Text style={{ color: colors.text }}>Restore</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={saving || !ready}
          onPress={save}
          style={[styles.action, { opacity: saving || !ready ? 0.5 : 1 }]}
        >
          <Text style={{ color: colors.text, fontWeight: "600" }}>
            {saving ? "Saving…" : "Save"}
          </Text>
        </Pressable>
      </View>
      {/* Below the field, so that showing it moves nothing being typed in. */}
      {spending.failure && (
        <Failure
          message={spending.error ?? "Couldn’t load spending."}
          hint={null}
          error={spending.failure}
          onRetry={null}
          onDismiss={null}
        />
      )}
      {replacement !== null && (
        <ConfirmDialog
          title={replacement ? "Replace API key?" : "Remove API key?"}
          message={
            replacement
              ? "The saved key is erased from this phone and can’t be shown again."
              : "The saved key is erased from this phone and can’t be shown again. OpenRouter stays disconnected until you add a key."
          }
          confirmLabel={replacement ? "Replace key" : "Remove key"}
          cancelLabel="Cancel"
          tone="danger"
          onConfirm={() => {
            setReplacement(null);
            void store(replacement);
          }}
          onCancel={() => {
            setReplacement(null);
            acceptKey(savedKey);
          }}
        />
      )}
      {scanning && (
        <KeyScanner
          onRead={(key) => {
            acceptKey(key);
            setScanning(false);
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </View>
  );
}
