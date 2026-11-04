import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import SquarePen from "lucide-react-native/icons/square-pen";
import Folder from "lucide-react-native/icons/folder";
import Settings from "lucide-react-native/icons/settings";
import X from "lucide-react-native/icons/x";

import type { ChatColors } from "./theme";

type ChatHeaderProps = { colors: ChatColors } & (
  | {
      mode: "settings";
      title?: string;
      onClose: () => void;
      closeDisabled?: boolean;
    }
  | {
      mode: "chat" | "history";
      newChatDisabled: boolean;
      navigationDisabled?: boolean;
      onNewChat: () => void;
      onNavigate: () => void;
      onSettings: () => void;
    }
);

export function ChatHeader(props: ChatHeaderProps) {
  const { colors, mode } = props;
  return (
    <View style={[styles.header, { borderBottomColor: colors.line }]}>
      <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
        {props.mode === "settings" ? (props.title ?? "Settings") : "AGSpeak"}
      </Text>
      <View style={styles.actions}>
        {props.mode !== "settings" && (
          <>
            <HeaderAction
              colors={colors}
              label="Start a new chat"
              disabled={props.newChatDisabled}
              onPress={props.onNewChat}
            >
              <SquarePen size={22} color={colors.text} />
            </HeaderAction>
            <HeaderAction
              colors={colors}
              label={
                mode === "history" ? "Close chat history" : "Open chat history"
              }
              selected={mode === "history"}
              disabled={props.navigationDisabled}
              onPress={props.onNavigate}
            >
              <Folder size={22} color={colors.text} />
            </HeaderAction>
          </>
        )}
        {props.mode === "settings" ? (
          <HeaderAction
            colors={colors}
            label={props.title ? "Close key scanner" : "Close settings"}
            disabled={props.closeDisabled}
            onPress={props.onClose}
          >
            <X size={23} color={colors.text} />
          </HeaderAction>
        ) : (
          <HeaderAction
            colors={colors}
            label="Open settings"
            onPress={props.onSettings}
          >
            <Settings size={22} color={colors.text} />
          </HeaderAction>
        )}
      </View>
    </View>
  );
}

function HeaderAction({
  colors,
  label,
  disabled = false,
  selected = false,
  onPress,
  children,
}: {
  colors: ChatColors;
  label: string;
  disabled?: boolean;
  selected?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        {
          backgroundColor: selected || pressed ? colors.bubble : undefined,
          opacity: disabled ? 0.35 : 1,
        },
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  title: { flex: 1, fontSize: 22, fontWeight: "700", letterSpacing: -0.6 },
  actions: { flexDirection: "row", alignItems: "center", gap: 4 },
  action: {
    width: 44,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
  },
});
