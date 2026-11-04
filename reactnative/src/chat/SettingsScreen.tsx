import { useRef } from 'react';
import { Keyboard, KeyboardAvoidingView, Modal, Platform, ScrollView, TouchableWithoutFeedback } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ChatHeader } from './ChatHeader';
import { ModelPicker, type ModelPickerHandle } from './ModelPicker';
import { OpenRouterSection } from './OpenRouterSection';
import { useKeyboardVisible } from './useKeyboardVisible';
import { settingsStyles as styles } from './settingsStyles';
import type { ModelSettings } from './openRouter';
import type { ChatColors } from './theme';

type SettingsScreenProps = {
  colors: ChatColors; initial: ModelSettings; onSaveKey: (key: string) => Promise<void>;
  onSaveModel: (model: string) => Promise<void>; onClose: () => void;
};

export function SettingsScreen({ colors, initial, onSaveKey, onSaveModel, onClose }: SettingsScreenProps) {
  const pickerRef = useRef<ModelPickerHandle>(null);
  function close() { pickerRef.current?.finishEditing(); Keyboard.dismiss(); onClose(); }
  const keyboardVisible = useKeyboardVisible();
  return (
    <Modal visible animationType="slide" onRequestClose={close}>
      <SafeAreaProvider>
        <KeyboardAvoidingView style={[styles.screen, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <TouchableWithoutFeedback onPress={() => Keyboard.dismiss()} accessible={false}>
            <SafeAreaView style={styles.screen} edges={keyboardVisible ? ['top', 'left', 'right'] : undefined}>
              <ChatHeader mode="settings" colors={colors} onClose={close} />
              <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                <ModelPicker ref={pickerRef} colors={colors} initial={initial.model} onSave={onSaveModel} />
                <OpenRouterSection colors={colors} savedKey={initial.apiKey} onSave={onSaveKey} />
              </ScrollView>
            </SafeAreaView>
          </TouchableWithoutFeedback>
        </KeyboardAvoidingView>
      </SafeAreaProvider>
    </Modal>
  );
}
