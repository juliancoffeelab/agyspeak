import { memo, useMemo } from "react";
import { Alert, Linking, Platform } from "react-native";
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
} from "react-native-enriched-markdown";
import type { ChatColors } from "./theme";

function openLink({ url }: { url: string }) {
  // Markdown links navigate only on an explicit tap, through the platform browser.
  if (!/^https?:\/\//i.test(url)) return;
  void Linking.openURL(url).catch(() =>
    Alert.alert("Couldn’t open this link."),
  );
}
const parserFlags = { latexMath: false };

export const MarkdownMessage = memo(function MarkdownMessage({
  text,
  colors,
}: {
  text: string;
  colors: ChatColors;
}) {
  const markdownStyle = useMemo<MarkdownStyle>(() => {
    const body = { color: colors.text, fontSize: 17, lineHeight: 26 };
    const heading = {
      color: colors.text,
      fontWeight: "600",
      marginTop: 14,
      marginBottom: 8,
    };
    return {
      paragraph: { ...body, marginTop: 0, marginBottom: 10 },
      h1: { ...heading, fontSize: 26, lineHeight: 34 },
      h2: { ...heading, fontSize: 23, lineHeight: 31 },
      h3: { ...heading, fontSize: 20, lineHeight: 28 },
      h4: { ...heading, fontSize: 18, lineHeight: 26 },
      h5: { ...heading, fontSize: 17, lineHeight: 26 },
      h6: { ...heading, fontSize: 17, lineHeight: 26 },
      list: {
        ...body,
        bulletColor: colors.text,
        markerColor: colors.text,
        marginTop: 0,
        marginBottom: 10,
      },
      blockquote: {
        ...body,
        color: colors.muted,
        borderColor: colors.line,
        backgroundColor: colors.background,
        borderWidth: 3,
        gapWidth: 12,
      },
      codeBlock: {
        color: colors.text,
        backgroundColor: colors.surface,
        borderColor: colors.line,
        borderRadius: 10,
        borderWidth: 1,
        padding: 12,
        fontSize: 14,
        lineHeight: 21,
        fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      },
      code: { color: colors.text, backgroundColor: colors.bubble },
      link: { color: colors.text, underline: true },
      strong: { color: colors.text },
      em: { color: colors.text },
      thematicBreak: { color: colors.line },
      table: {
        color: colors.text,
        fontSize: 14,
        borderColor: colors.line,
        headerBackgroundColor: colors.bubble,
        headerTextColor: colors.text,
        rowEvenBackgroundColor: colors.background,
        rowOddBackgroundColor: colors.surface,
      },
    };
  }, [colors]);
  return (
    <EnrichedMarkdownText
      markdown={text}
      flavor="github"
      selectable
      enableTaskListItemToggle={false}
      md4cFlags={parserFlags}
      markdownStyle={markdownStyle}
      onLinkPress={openLink}
    />
  );
});
