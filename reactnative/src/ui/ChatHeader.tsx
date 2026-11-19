import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import SquarePen from "lucide-react-native/icons/square-pen";
import Folder from "lucide-react-native/icons/folder";
import Settings from "lucide-react-native/icons/settings";
import ChevronDown from "lucide-react-native/icons/chevron-down";
import X from "lucide-react-native/icons/x";

import { useColors } from "./theme";

type ChatHeaderProps =
  | {
      mode: "settings";
      title: string;
      // What the close action says it closes, for screen readers.
      closeLabel: string;
      onClose: () => void;
    }
  | ({
      newChatDisabled: boolean;
      navigationDisabled: boolean;
      onNewChat: () => void;
      onNavigate: () => void;
      onSettings: () => void;
    } & (
      | {
          mode: "chat";
          // Null where there is no chat whose model could be changed.
          modelSelector: {
            label: string;
            disabled: boolean;
            onPress: () => void;
          } | null;
        }
      | { mode: "history" }
    ));

export function ChatHeader(props: ChatHeaderProps) {
  const colors = useColors();
  const { mode } = props;
  return (
    <View style={[styles.header, { borderBottomColor: colors.line }]}>
      {props.mode === "chat" && props.modelSelector ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Change model, currently ${props.modelSelector.label}`}
          disabled={props.modelSelector.disabled}
          onPress={props.modelSelector.onPress}
          style={styles.modelSelector}
        >
          <Text
            numberOfLines={1}
            style={[styles.modelTitle, { color: colors.text }]}
          >
            {props.modelSelector.label.replace(/^[^:/]+:\s+/, "")}
          </Text>
          <ChevronDown size={17} color={colors.muted} />
        </Pressable>
      ) : (
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
          {props.mode === "settings"
            ? props.title
            : props.mode === "history"
              ? "History"
              : "AGSpeak"}
        </Text>
      )}
      <View style={styles.actions}>
        {props.mode !== "settings" && (
          <>
            <HeaderAction
              label="Start a new chat"
              selected={false}
              disabled={props.newChatDisabled}
              onPress={props.onNewChat}
            >
              <SquarePen size={22} color={colors.text} />
            </HeaderAction>
            <HeaderAction
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
            label={props.closeLabel}
            selected={false}
            disabled={false}
            onPress={props.onClose}
          >
            <X size={23} color={colors.text} />
          </HeaderAction>
        ) : (
          <HeaderAction
            label="Open settings"
            selected={false}
            disabled={false}
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
  label,
  disabled,
  selected,
  onPress,
  children,
}: {
  label: string;
  disabled: boolean;
  selected: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const colors = useColors();
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
  modelSelector: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  modelTitle: { flexShrink: 1, fontSize: 18, fontWeight: "600" },
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
