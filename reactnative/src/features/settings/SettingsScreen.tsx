import { useEffect, type ReactNode } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TouchableWithoutFeedback,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRouter } from "expo-router";
import { ChatHeader } from "../../ui/ChatHeader";
import { DefaultModelSetting } from "./DefaultModelSetting";
import { OpenRouterSection } from "./OpenRouterSection";
import { SpeechLanguageSetting } from "./SpeechLanguageSetting";
import { useKeyboardVisible } from "../../ui/useKeyboardVisible";
import { settingsStyles as styles } from "../../ui/settingsStyles";
import { useSettingsScope } from "./settingsContext";
import { useColors } from "../../ui/theme";

// The header shows from the first frame; `status` fills the settings' place
// until they are open.
export function SettingsScreen({ status }: { status: ReactNode }) {
  const scope = useSettingsScope();
  const router = useRouter();
  const navigation = useNavigation();
  const colors = useColors();
  useEffect(
    () => navigation.addListener("blur", () => Keyboard.dismiss()),
    [navigation],
  );
  const keyboardVisible = useKeyboardVisible();
  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <TouchableWithoutFeedback
        onPress={() => Keyboard.dismiss()}
        accessible={false}
      >
        <SafeAreaView
          style={styles.screen}
          edges={keyboardVisible ? ["top", "left", "right"] : undefined}
        >
          <ChatHeader
            mode="settings"
            title="Settings"
            closeLabel="Close settings"
            onClose={() => router.back()}
          />
          <ScrollView
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
          >
            {scope ? (
              <>
                <DefaultModelSetting preferences={scope.preferences} />
                <SpeechLanguageSetting preferences={scope.preferences} />
                <OpenRouterSection connection={scope.connection} />
              </>
            ) : (
              status
            )}
          </ScrollView>
        </SafeAreaView>
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
}
