import {
  memo,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type HostInstance,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import Copy from "lucide-react-native/icons/copy";
import Check from "lucide-react-native/icons/check";
import Volume2 from "lucide-react-native/icons/volume-2";
import Languages from "lucide-react-native/icons/languages";
import RotateCw from "lucide-react-native/icons/rotate-cw";
import StepForward from "lucide-react-native/icons/step-forward";
import Trash from "lucide-react-native/icons/trash";
import EllipsisVertical from "lucide-react-native/icons/ellipsis-vertical";
import CalendarClock from "lucide-react-native/icons/calendar-clock";
import Timer from "lucide-react-native/icons/timer";
import ArrowDownUp from "lucide-react-native/icons/arrow-down-up";
import Database from "lucide-react-native/icons/database";
import Gauge from "lucide-react-native/icons/gauge";
import Square from "lucide-react-native/icons/square";
import { useStore } from "zustand";

import { speechLanguageLabel } from "../../device/speech/language";
import { SpeechLanguagePicker } from "../../ui/SpeechLanguagePicker";
import {
  Popover,
  PopoverAction,
  PopoverDivider,
  PopoverInfo,
  type Anchor,
} from "../../ui/Popover";
import { useChatScope } from "./chatContext";
import type { Usage } from "../../providers/openrouter/transport";
import { notify } from "../../ui/notice";
import { useColors } from "../../ui/theme";

// The row under a message: reading it aloud and in which language, copying
// it, and a menu of what is known about it and what can be done with it.
// A reply's menu tells when it was asked for, how long it took, the tokens
// it used and how full it left the chat; a message of yours, when you
// posted it. What a message has no text for, such as a recording or photos
// alone, isn't offered to read or copy.
// What the row knows of the message it is under: a message of yours, or a
// reply as a whole, its parts' times and tokens added up.
export type ShownEntry = {
  // Names the message among every chat's, for reading it aloud.
  key: string;
  role: "user" | "assistant";
  // What is read and copied; null when it has no words to offer.
  text: string | null;
  postedAt: number | null;
  elapsedMillis: number | null;
  usage: Pick<
    Usage,
    "promptTokens" | "completionTokens" | "cachedPromptTokens"
  > | null;
};

// Something the menu can do with the reply; `issue` is why the chat won't
// take it now, told when it is pressed.
export type EntryAction = {
  kind: "retry" | "continue" | "discard";
  issue: string | null;
  disabled: boolean;
  onPress: () => void;
};

const ACTIONS = {
  retry: { label: "Retry", Icon: RotateCw },
  continue: { label: "Continue", Icon: StepForward },
  discard: { label: "Discard", Icon: Trash },
} as const;

export const MessageActions = memo(function MessageActions({
  message,
  gauge,
  writing,
  actions,
}: {
  message: ShownEntry;
  // How full the chat is against its limit, from above (see
  // `requestSize`), told on its latest reply only. Null elsewhere.
  gauge: { tokens: number; limit: number } | null;
  // The reply is still being written: the row holds its place, unseen, so
  // that it neither appears with a jump at the end nor rides the growing
  // text on screen.
  writing: boolean;
  actions: readonly EntryAction[];
}) {
  const { key: id, role, text } = message;
  const reply = role === "assistant";
  const colors = useColors();
  const { speech, responseSpeech, preferences } = useChatScope();
  const speaking = useSyncExternalStore(
    speech.subscribe,
    () => speech.getSnapshot().playing === id,
  );
  const recording = useSyncExternalStore(
    speech.subscribe,
    () => speech.getSnapshot().recording,
  );
  // A choice for this message overrides the saved default.
  const override = useStore(
    responseSpeech.languages,
    (languages) => languages.get(id) ?? null,
  );
  // The saved read-aloud default; null means the device's default voice.
  const fallback = useStore(preferences, (state) => state.speechLanguage);
  const language = override ?? fallback;
  const selectedLabel = language
    ? speechLanguageLabel(language)
    : "Device default";
  // Recycled rows show another message: what is open belongs to one id.
  const [pickerId, setPickerId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; anchor: Anchor } | null>(null);
  const copied = copiedId === id;
  const menuRef = useRef<HostInstance>(null);
  const aliveRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);
  async function copy(copiedText: string) {
    try {
      await Clipboard.setStringAsync(copiedText);
      if (!aliveRef.current) return;
      setCopiedId(id);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopiedId(null), 1800);
    } catch {
      notify(
        reply ? "Couldn’t copy the response." : "Couldn’t copy the message.",
        null,
      );
    }
  }

  const info = menuInfo(message, gauge, colors.muted);
  const hasMenu = info.length > 0 || actions.length > 0;
  if (text === null && !hasMenu && !writing) return null;
  return (
    <View
      style={[styles.row, reply && styles.replyRow, writing && styles.unseen]}
      pointerEvents={writing ? "none" : "auto"}
      importantForAccessibility={writing ? "no-hide-descendants" : "auto"}
    >
      {pickerId === id && (
        <SpeechLanguagePicker
          selected={override}
          unsetLabel={
            fallback
              ? `Default (${speechLanguageLabel(fallback)})`
              : "Device default"
          }
          onSelect={(code) => responseSpeech.setLanguage(id, code)}
          onClose={() => setPickerId(null)}
        />
      )}
      {menu?.id === id && (
        <Popover
          anchor={menu.anchor}
          closeLabel="Close message menu"
          onClose={() => setMenu(null)}
        >
          {info.map((line) => (
            <PopoverInfo key={line.key} icon={line.icon} label={line.label}>
              {line.text}
            </PopoverInfo>
          ))}
          {info.length > 0 && actions.length > 0 && <PopoverDivider />}
          {actions.map((action) => {
            const { label, Icon } = ACTIONS[action.kind];
            return (
              <PopoverAction
                key={action.kind}
                icon={<Icon size={18} color={colors.text} />}
                label={label}
                hint={action.issue}
                disabled={action.disabled}
                dimmed={action.issue !== null}
                onPress={() => {
                  setMenu(null);
                  action.onPress();
                }}
              />
            );
          })}
        </Popover>
      )}

      {text !== null && (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              speaking
                ? reply
                  ? "Stop reading response"
                  : "Stop reading message"
                : reply
                  ? "Read response aloud"
                  : "Read message aloud"
            }
            disabled={recording}
            onPress={() => {
              void responseSpeech.toggle(id, text);
            }}
            style={[styles.button, { opacity: recording ? 0.35 : 1 }]}
          >
            {speaking ? (
              <Square size={16} color={colors.muted} />
            ) : (
              <Volume2 size={18} color={colors.muted} />
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Read-aloud language: ${selectedLabel}`}
            onPress={() => setPickerId(id)}
            style={styles.button}
          >
            {language ? (
              <Text style={[styles.language, { color: colors.muted }]}>
                {language.split("-")[0].toUpperCase()}
              </Text>
            ) : (
              <Languages size={18} color={colors.muted} />
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              copied
                ? reply
                  ? "Response copied"
                  : "Message copied"
                : reply
                  ? "Copy response"
                  : "Copy message"
            }
            onPress={() => {
              void copy(text);
            }}
            style={styles.button}
          >
            {copied ? (
              <Check size={18} color={colors.muted} />
            ) : (
              <Copy size={18} color={colors.muted} />
            )}
          </Pressable>
        </>
      )}
      {hasMenu && (
        <Pressable
          ref={menuRef}
          accessibilityRole="button"
          accessibilityLabel={reply ? "Response menu" : "Message menu"}
          onPress={() =>
            menuRef.current?.measureInWindow((x, y, width, height) =>
              setMenu({ id, anchor: { x, y, width, height } }),
            )
          }
          style={styles.button}
        >
          <EllipsisVertical size={18} color={colors.muted} />
        </Pressable>
      )}
    </View>
  );
});

// The menu's lines for what is known of `message`; a reply saved before
// these were kept, or that the provider reported nothing for, has fewer.
// When a message was posted: the time alone today, otherwise the date too.
function postedTime(postedAt: number) {
  const date = new Date(postedAt);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function menuInfo(
  message: ShownEntry,
  gauge: { tokens: number; limit: number } | null,
  color: string,
) {
  const lines: {
    key: string;
    icon: ReactNode;
    label: string;
    text: string;
  }[] = [];
  const posted =
    message.postedAt === null ? null : postedTime(message.postedAt);
  if (posted !== null)
    lines.push({
      key: "posted",
      icon: <CalendarClock size={16} color={color} />,
      label: `${message.role === "assistant" ? "Asked" : "Posted"} ${posted}`,
      text: posted,
    });
  if (message.role === "user") return lines;
  const count = (value: number) => value.toLocaleString();
  if (message.elapsedMillis !== null) {
    const seconds = (message.elapsedMillis / 1000).toFixed(1);
    lines.push({
      key: "duration",
      icon: <Timer size={16} color={color} />,
      label: `Took ${seconds} seconds`,
      text: `${seconds} s`,
    });
  }
  const promptTokens = message.usage?.promptTokens ?? null;
  const completionTokens = message.usage?.completionTokens ?? null;
  const cachedTokens = message.usage?.cachedPromptTokens ?? null;
  if (promptTokens !== null && completionTokens !== null)
    lines.push({
      key: "tokens",
      icon: <ArrowDownUp size={16} color={color} />,
      label: `${count(promptTokens)} tokens in, ${count(completionTokens)} out`,
      text: `${count(promptTokens)} in · ${count(completionTokens)} out`,
    });
  if (cachedTokens)
    lines.push({
      key: "cached",
      icon: <Database size={16} color={color} />,
      label: `${count(cachedTokens)} tokens read from cache`,
      text: `${count(cachedTokens)} cached`,
    });
  if (gauge !== null) {
    const size = count(gauge.tokens);
    const limit = count(gauge.limit);
    lines.push({
      key: "context",
      icon: <Gauge size={16} color={color} />,
      label: `Chat at up to ${size} of its ${limit}-token limit`,
      text: `≤ ${size} of ${limit}`,
    });
  }
  return lines;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", minHeight: 40 },
  replyRow: { marginTop: 6 },
  unseen: { opacity: 0 },
  button: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  language: { fontSize: 12, fontWeight: "600" },
});
