import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import Camera from "lucide-react-native/icons/camera";
import Images from "lucide-react-native/icons/images";
import AudioLines from "lucide-react-native/icons/audio-lines";
import { SafeAreaView } from "react-native-safe-area-context";
import { useColors } from "../../ui/theme";

export function AttachmentMenu({
  visible,
  onClose,
  audioIssue,
  imageIssue,
  onChoose,
}: {
  visible: boolean;
  audioIssue: string | null;
  imageIssue: string | null;
  onClose: () => void;
  onChoose: (source: "camera" | "photos" | "audio") => void;
}) {
  const colors = useColors();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close attachments"
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
        <SafeAreaView
          edges={["bottom", "left", "right"]}
          style={[styles.sheet, { backgroundColor: colors.surface }]}
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
              <Text style={[styles.label, { color: colors.text }]}>
                {label}
              </Text>
            </Pressable>
          ))}
        </SafeAreaView>
      </View>
    </Modal>
  );
}
const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16 },
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
