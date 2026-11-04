import { useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import { ActivityIndicator, Alert, Keyboard, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyScanner } from './KeyScanner';
import { dollars } from './routerMetadata';
import { parseKeyInput } from './settings';
import { useRouterUsage } from './useRouterMetadata';
import { settingsStyles as styles } from './settingsStyles';
import type { ChatColors } from './theme';

export function OpenRouterSection({ colors, savedKey, onSave }: {
  colors: ChatColors; savedKey: string; onSave: (key: string) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState(savedKey);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const spending = useRouterUsage(savedKey);
  const canRestore = Boolean(savedKey) && !saving && (apiKey !== savedKey || keyError !== null);
  const status = keyError ?? (spending.state === 'invalid' ? 'Invalid saved key'
    : spending.error ? 'Spending refresh failed' : '');

  function acceptKey(key: string) {
    setApiKey(key);
    setKeyError(null);
  }
  async function paste() {
    try { acceptKey(parseKeyInput(await Clipboard.getStringAsync())); }
    catch { setKeyError('Copy an OpenRouter key first'); }
  }

  async function save() {
    if (saving) return;
    try {
      const next = apiKey.trim() ? parseKeyInput(apiKey) : '';
      Keyboard.dismiss();
      setSaving(true);
      if (next === savedKey) { acceptKey(savedKey); return; }
      if (savedKey) {
        const replace = await new Promise<boolean>(resolve => {
          Alert.alert(next ? 'Replace API key?' : 'Remove API key?', next ? 'Use the new key for future requests?' : 'Disconnect OpenRouter until you add another key?', [
            { text: 'Keep current key', style: 'cancel', onPress: () => resolve(false) },
            { text: next ? 'Replace key' : 'Remove key', style: next ? 'default' : 'destructive', onPress: () => resolve(true) },
          ], { cancelable: true, onDismiss: () => resolve(false) });
        });
        if (!replace) { acceptKey(savedKey); return; }
      }
      await onSave(next);
      acceptKey(next);
    } catch (cause) {
      setKeyError(cause instanceof Error && cause.message.startsWith('That does not') ? 'Invalid key' : 'Couldn’t save key. Try again.');
    } finally { setSaving(false); }
  }

  return (
    <View style={[styles.section, styles.routerSection, { borderTopColor: colors.line }]}>
      <View style={styles.sectionHeading}>
        <Text style={[styles.label, { color: colors.text }]}>OpenRouter</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh OpenRouter spending" accessibilityState={{ busy: spending.loading }}
          disabled={spending.loading || !spending.canRefresh} onPress={spending.refresh} style={styles.iconButton}>
          {spending.loading ? <ActivityIndicator size="small" color={colors.muted} /> : <RefreshCw size={20} color={colors.muted} style={{ opacity: spending.canRefresh ? 1 : 0.35 }} />}
        </Pressable>
      </View>
      <View style={styles.metrics} accessibilityLabel={`OpenRouter spending: ${spending.state}`}>
        <View style={styles.metric}>
          <Text numberOfLines={1} style={[styles.hint, { color: colors.muted }]}>{spending.usage?.accountBalance ? 'Remaining' : 'Key remaining'}</Text>
          <Text style={[styles.amount, { color: colors.text }]}>{spending.usage ? spending.usage.remaining === null ? 'No cap' : dollars(spending.usage.remaining) : '—'}</Text>
        </View>
        <View style={styles.metric}>
          <Text style={[styles.hint, { color: colors.muted }]}>Today</Text>
          <Text style={[styles.amount, { color: colors.text }]}>{spending.usage ? dollars(spending.usage.daily) : '—'}</Text>
        </View>
        <View style={styles.metric}>
          <Text style={[styles.hint, { color: colors.muted }]}>This month</Text>
          <Text style={[styles.amount, { color: colors.text }]}>{spending.usage ? dollars(spending.usage.monthly) : '—'}</Text>
        </View>
      </View>
      <View style={styles.fieldHeading}>
        <Text style={[styles.fieldLabel, { color: colors.text }]}>API key</Text>
        <Text accessibilityRole={status ? 'alert' : undefined} accessibilityLabel={spending.error ?? status} numberOfLines={1} style={[styles.spendError, { color: colors.muted }]}>{status}</Text>
      </View>
      <TextInput accessibilityLabel="OpenRouter API key" value={apiKey}
        onChangeText={value => { setApiKey(value); setKeyError(null); }}
        onSubmitEditing={() => Keyboard.dismiss()}
        secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder="API key" placeholderTextColor={colors.muted}
        underlineColorAndroid="transparent" style={[styles.input, { color: colors.text, borderColor: colors.line }]} />
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" onPress={() => { void paste(); }} style={styles.action}><Text style={{ color: colors.text }}>Paste key</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={() => { Keyboard.dismiss(); setScanning(true); }} style={styles.action}><Text style={{ color: colors.text }}>Scan QR</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Restore saved API key" disabled={!canRestore} onPress={() => acceptKey(savedKey)} style={[styles.action, { opacity: canRestore ? 1 : 0.4 }]}><Text style={{ color: colors.text }}>Restore</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={saving} onPress={() => { void save(); }} style={[styles.action, { opacity: saving ? 0.5 : 1 }]}><Text style={{ color: colors.text, fontWeight: '600' }}>{saving ? 'Saving…' : 'Save'}</Text></Pressable>
      </View>
      {scanning && <Modal visible animationType="slide" onRequestClose={() => setScanning(false)}>
        <SafeAreaProvider>
          <KeyScanner colors={colors} onRead={key => { acceptKey(key); setScanning(false); }} onClose={() => setScanning(false)} />
        </SafeAreaProvider>
      </Modal>}
    </View>
  );
}
