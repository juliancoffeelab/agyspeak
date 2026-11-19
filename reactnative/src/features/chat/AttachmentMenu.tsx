import { Pressable, StyleSheet, Text } from "react-native";
import Camera from "lucide-react-native/icons/camera";
import Images from "lucide-react-native/icons/images";
import AudioLines from "lucide-react-native/icons/audio-lines";
import { Overlay } from "../../ui/Overlay";
import { useColors } from "../../ui/theme";

export function AttachmentMenu({
  onClose,
  audioIssue,
  imageIssue,
  onChoose,
}: {
  audioIssue: string | null;
  imageIssue: string | null;
  onClose: () => void;
  onChoose: (source: "camera" | "photos" | "audio") => void;
}) {
  const colors = useColors();
  return (
    <Overlay
      placement="bottom"
      closeLabel="Close attachments"
      onClose={onClose}
    >
      <Text style={[styles.title, { color: colors.muted }]}>Attach</Text>
      {(
        [
          ["camera", "Camera", Camera],
          ["photos", "Photos", Images],
          ["audio", "Audio file", AudioLines],
        ] as const
      ).map(([source, label, Icon]) => (
        <Pressable
          key={source}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={
            (source === "audio" ? audioIssue : imageIssue) ?? undefined
          }
          style={[
            styles.action,
            {
              opacity: (source === "audio" ? audioIssue : imageIssue)
                ? 0.35
                : 1,
            },
          ]}
          onPress={() => onChoose(source)}
        >
          <Icon size={23} color={colors.text} />
          <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
        </Pressable>
      ))}
    </Overlay>
  );
}
const styles = StyleSheet.create({
  title: { fontSize: 13, paddingHorizontal: 16, paddingVertical: 8 },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
    minHeight: 56,
    paddingHorizontal: 16,
  },
  label: { fontSize: 17 },
});
