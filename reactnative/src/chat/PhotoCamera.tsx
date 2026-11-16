import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  AppState,
} from "react-native";
import { CameraView, type CameraCapturedPicture } from "expo-camera";
import { File } from "expo-file-system";
import { SafeAreaView } from "react-native-safe-area-context";
import X from "lucide-react-native/icons/x";
import SwitchCamera from "lucide-react-native/icons/switch-camera";
import { cameraPictureSize } from "./photoInteraction";

function remove(uri: string | null) {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    /* Cache cleanup is best effort. */
  }
}

export function PhotoCamera({
  onClose,
  onAttach,
}: {
  onClose: () => void;
  onAttach: (photo: CameraCapturedPicture) => Promise<void>;
}) {
  const cameraRef = useRef<CameraView>(null);
  const aliveRef = useRef(false);
  const lockedRef = useRef(false);
  const uriRef = useRef<string | null>(null);
  const [photo, setPhoto] = useState<CameraCapturedPicture | null>(null);
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [size, setSize] = useState<string>();
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    aliveRef.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
      if (state !== "active") setReady(false);
    });
    return () => {
      aliveRef.current = false;
      subscription.remove();
      remove(uriRef.current);
    };
  }, []);
  async function readyCamera() {
    const camera = cameraRef.current;
    if (!camera) return;
    try {
      const sizes = await camera.getAvailablePictureSizesAsync();
      if (aliveRef.current && cameraRef.current === camera)
        setSize(cameraPictureSize(sizes));
    } catch {
      /* Keep the platform default if size discovery is unavailable. */
    }
    if (aliveRef.current && cameraRef.current === camera) setReady(true);
  }
  async function shoot() {
    if (lockedRef.current || !ready || !cameraRef.current) return;
    lockedRef.current = true;
    setWorking(true);
    setError(null);
    try {
      const shot = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        shutterSound: false,
      });
      if (!aliveRef.current) {
        remove(shot.uri);
        return;
      }
      uriRef.current = shot.uri;
      setPhoto(shot);
    } catch {
      if (aliveRef.current) setError("Couldn’t take the photo. Try again.");
    } finally {
      lockedRef.current = false;
      if (aliveRef.current) setWorking(false);
    }
  }
  async function attach() {
    if (!photo || lockedRef.current) return;
    lockedRef.current = true;
    setWorking(true);
    setError(null);
    try {
      await onAttach(photo);
      if (aliveRef.current) onClose();
    } catch (cause) {
      if (aliveRef.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Couldn’t attach the photo. Try again.",
        );
    } finally {
      lockedRef.current = false;
      if (aliveRef.current) setWorking(false);
    }
  }
  function retake() {
    remove(uriRef.current);
    uriRef.current = null;
    setPhoto(null);
    setReady(false);
    setError(null);
  }
  return (
    <Modal animationType="fade" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close camera"
            onPress={onClose}
            style={styles.icon}
          >
            <X size={24} color="white" />
          </Pressable>
        </View>
        <View style={styles.preview}>
          {photo ? (
            <Image
              source={{ uri: photo.uri }}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
              accessibilityLabel="Photo review"
            />
          ) : (
            foreground && (
              <CameraView
                key={facing}
                ref={cameraRef}
                style={StyleSheet.absoluteFill}
                facing={facing}
                pictureSize={size}
                onCameraReady={() => {
                  void readyCamera();
                }}
                onMountError={() =>
                  setError("Couldn’t open the camera. Close it and try again.")
                }
              />
            )
          )}
        </View>
        {error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <View style={styles.actions}>
          {photo ? (
            <>
              <Pressable
                accessibilityRole="button"
                disabled={working}
                onPress={retake}
                style={styles.action}
              >
                <Text style={styles.label}>Retake photo</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={working}
                onPress={() => {
                  void attach();
                }}
                style={[styles.action, styles.attach]}
              >
                {working ? (
                  <ActivityIndicator color="black" />
                ) : (
                  <Text style={styles.attachLabel}>Attach photo</Text>
                )}
              </Pressable>
            </>
          ) : (
            <>
              <View style={styles.icon} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Take photo"
                disabled={!ready || working || !foreground}
                onPress={() => {
                  void shoot();
                }}
                style={[styles.shutter, { opacity: ready ? 1 : 0.4 }]}
              >
                {working ? (
                  <ActivityIndicator color="black" />
                ) : (
                  <View style={styles.shutterInner} />
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Switch camera"
                disabled={working}
                onPress={() => {
                  setReady(false);
                  setSize(undefined);
                  setFacing((current) =>
                    current === "back" ? "front" : "back",
                  );
                }}
                style={styles.icon}
              >
                <SwitchCamera size={25} color="white" />
              </Pressable>
            </>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "black" },
  header: { alignItems: "flex-end" },
  icon: {
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  preview: { flex: 1, overflow: "hidden" },
  actions: {
    minHeight: 108,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    gap: 16,
    paddingHorizontal: 20,
  },
  action: {
    flex: 1,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 26,
  },
  attach: { backgroundColor: "white" },
  label: { color: "white", fontSize: 16 },
  attachLabel: { color: "black", fontSize: 16, fontWeight: "600" },
  error: { color: "white", padding: 16 },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 3,
    borderColor: "white",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    width: 62,
    height: 62,
    backgroundColor: "white",
    borderRadius: 31,
  },
});
