import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useStore } from "zustand";
import { speechLanguageLabel } from "../../device/speech/language";
import type { PreferencesOwner } from "../../preferences/preferences";
import { settingsStyles as styles } from "../../ui/settingsStyles";
import { SpeechLanguagePicker } from "../../ui/SpeechLanguagePicker";
import { notify } from "../../ui/notice";
import { useColors } from "../../ui/theme";

// The read-aloud language for responses without their own choice.
export function SpeechLanguageSetting({
  preferences,
}: {
  preferences: PreferencesOwner;
}) {
  const colors = useColors();
  const language = useStore(preferences.state, (state) => state.speechLanguage);
  const [choosing, setChoosing] = useState(false);
  const label = language ? speechLanguageLabel(language) : "Device default";
  return (
    <View style={styles.section}>
      <Text style={[styles.label, { color: colors.text }]}>
        Read-aloud language
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Read-aloud language: ${label}`}
        onPress={() => setChoosing(true)}
        style={[styles.input, styles.choice, { borderColor: colors.line }]}
      >
        <Text style={[styles.choiceText, { color: colors.text }]}>{label}</Text>
      </Pressable>
      {choosing && (
        <SpeechLanguagePicker
          selected={language}
          unsetLabel="Device default"
          onSelect={(code) => {
            preferences.saveSpeechLanguage(code).catch(() => {
              notify("Couldn’t save the read-aloud language.", null);
            });
          }}
          onClose={() => setChoosing(false)}
        />
      )}
    </View>
  );
}
