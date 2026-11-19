import type { ReactNode } from "react";
import {
  Keyboard,
  ScrollView,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { ChatHeader } from "../../ui/ChatHeader";
import { Screen } from "../../ui/Screen";
import { DefaultModelSetting } from "./DefaultModelSetting";
import { OpenRouterSection } from "./OpenRouterSection";
import { SpeechLanguageSetting } from "./SpeechLanguageSetting";
import { settingsStyles as styles } from "../../ui/settingsStyles";
import { useSettingsScope } from "./settingsContext";
import { useColors } from "../../ui/theme";

// The header shows from the first frame; `status` fills the settings' place
// until they are open.
export function SettingsScreen({ status }: { status: ReactNode }) {
  const scope = useSettingsScope();
  const router = useRouter();
  const colors = useColors();
  return (
    <Screen keyboard="pad" background={colors.background}>
      <TouchableWithoutFeedback
        onPress={() => Keyboard.dismiss()}
        accessible={false}
      >
        <View style={styles.screen}>
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
        </View>
      </TouchableWithoutFeedback>
    </Screen>
  );
}
