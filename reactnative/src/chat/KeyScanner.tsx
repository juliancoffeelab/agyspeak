import { useRef, useState } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ChatHeader } from "./ChatHeader";
import { parseKeyInput } from "./settings";
import type { ChatColors } from "./theme";

export function KeyScanner({
  colors,
  onRead,
  onClose,
}: {
  colors: ChatColors;
  onRead: (key: string) => void;
  onClose: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const scannedRef = useRef(false);
  return (
    <SafeAreaView
      style={[styles.screen, { backgroundColor: colors.background }]}
    >
      <ChatHeader
        mode="settings"
        title="Scan key"
        colors={colors}
        onClose={onClose}
      />
      {permission?.granted ? (
        <CameraView
          style={styles.screen}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            if (scannedRef.current) return;
            try {
              const key = parseKeyInput(data);
              scannedRef.current = true;
              onRead(key);
            } catch {
              setError("This QR does not contain an OpenRouter key.");
            }
          }}
        />
      ) : (
        <View style={styles.explanation}>
          <Text style={[styles.hint, { color: colors.text }]}>
            Allow the camera to scan the QR displayed on your computer.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void requestPermission();
            }}
            style={styles.button}
          >
            <Text style={{ color: colors.text }}>Allow camera</Text>
          </Pressable>
        </View>
      )}
      <Text
        accessibilityRole={error ? "alert" : "text"}
        style={[styles.hint, { color: colors.muted }]}
      >
        {error ?? "Point the camera at the key QR. It stays on this device."}
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  button: { padding: 16, minHeight: 48, justifyContent: "center" },
  explanation: { flex: 1, justifyContent: "center", padding: 20 },
  hint: { fontSize: 15, lineHeight: 23, padding: 20 },
});
