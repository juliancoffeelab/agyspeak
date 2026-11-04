import { useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ChatHeader } from './ChatHeader';
import { KeyScanner } from './KeyScanner';
import { parseKeyInput } from './settings';
import type { ModelSettings } from './openRouter';
import type { ChatColors } from './theme';

type SettingsScreenProps = { colors: ChatColors; initial: ModelSettings; onSave: (settings: ModelSettings) => Promise<void>; onClose: () => void };

export function SettingsScreen({ colors, initial, onSave, onClose }: SettingsScreenProps) {
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [model, setModel] = useState(initial.model);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    try {
      const key = apiKey.trim() ? parseKeyInput(apiKey) : '';
      if (!model.trim()) { setError('Choose a model first.'); return; }
      setSaving(true);
      await onSave({ apiKey: key, model: model.trim() });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error && cause.message.startsWith('That does not') ? cause.message : 'Couldn’t save settings. Please try again.');
    } finally { setSaving(false); }
  }

  async function paste() {
    try { setApiKey(parseKeyInput(await Clipboard.getStringAsync())); setError(null); }
    catch { setError('Copy an OpenRouter API key, then tap Paste key.'); }
  }

  return (
    <Modal visible animationType="slide" onRequestClose={() => { if (!saving) { if (scanning) setScanning(false); else onClose(); } }}>
      <SafeAreaProvider>
        {scanning ? <KeyScanner colors={colors} onRead={key => { setApiKey(key); setScanning(false); setError(null); }} onClose={() => setScanning(false)} /> : (
          <KeyboardAvoidingView style={[styles.screen, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <SafeAreaView style={styles.screen}>
              <ChatHeader mode="settings" colors={colors} onClose={onClose} closeDisabled={saving} />
              <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                <Text style={[styles.label, { color: colors.text }]}>OpenRouter key</Text>
                <TextInput accessibilityLabel="OpenRouter API key" value={apiKey} onChangeText={setApiKey} secureTextEntry autoCapitalize="none" autoCorrect={false}
                  placeholder="Paste or scan your key" placeholderTextColor={colors.muted} underlineColorAndroid="transparent"
                  style={[styles.input, { color: colors.text, borderColor: colors.line }]} />
                <View style={styles.actions}>
                  <Pressable accessibilityRole="button" onPress={() => { void paste(); }} style={styles.action}><Text style={{ color: colors.text }}>Paste key</Text></Pressable>
                  <Pressable accessibilityRole="button" onPress={() => setScanning(true)} style={styles.action}><Text style={{ color: colors.text }}>Scan QR</Text></Pressable>
                  <Pressable accessibilityRole="button" onPress={() => setApiKey('')} style={styles.action}><Text style={{ color: colors.muted }}>Clear</Text></Pressable>
                </View>
                <Text style={[styles.hint, { color: colors.muted }]}>Saved securely on this device. On your computer, run pnpm key:qr to display a key QR.</Text>
                <Text style={[styles.label, { color: colors.text }]}>Model</Text>
                <TextInput accessibilityLabel="OpenRouter model" value={model} onChangeText={setModel} autoCapitalize="none" autoCorrect={false}
                  underlineColorAndroid="transparent" style={[styles.input, { color: colors.text, borderColor: colors.line }]} />
                <Pressable accessibilityRole="button" onPress={() => setModel('google/gemini-3.8-flash')} style={styles.action}>
                  <Text style={{ color: colors.text }}>Use Gemini 3.8 Flash</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => setModel('openrouter/free')} style={styles.action}><Text style={{ color: colors.text }}>Use free router</Text></Pressable>
                <Text style={[styles.hint, { color: colors.muted }]}>Gemini 3.8 Flash currently costs $0.825/M input tokens and $4.125/M output tokens. The free router selects an available free model. Voice messages send recordings directly to the selected model, which must support audio. Text replies are limited to 512 tokens; replies with audio context are limited to 1,024 tokens.</Text>
                {error !== null && <Text accessibilityRole="alert" style={[styles.hint, { color: colors.text }]}>{error}</Text>}
                <Pressable accessibilityRole="button" disabled={saving} onPress={() => { void save(); }} style={[styles.save, { backgroundColor: colors.button, opacity: saving ? 0.5 : 1 }]}>
                  <Text style={{ color: colors.buttonText, fontWeight: '600' }}>{saving ? 'Saving…' : 'Save'}</Text>
                </Pressable>
              </ScrollView>
            </SafeAreaView>
          </KeyboardAvoidingView>
        )}
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { padding: 20, gap: 12 },
  label: { fontSize: 16, fontWeight: '600', marginTop: 12 },
  input: { borderWidth: 1, borderRadius: 12, padding: 14, minHeight: 48, fontSize: 16 },
  actions: { flexDirection: 'row', alignItems: 'center' },
  action: { paddingHorizontal: 12, minHeight: 48, justifyContent: 'center' },
  hint: { fontSize: 14, lineHeight: 21 },
  save: { padding: 16, alignItems: 'center', borderRadius: 12, minHeight: 48, marginTop: 12 },
});
