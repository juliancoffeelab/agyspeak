import { useQuery } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import X from "lucide-react-native/icons/x";
import type { PhotoInput, PhotoReference } from "./history";

export function PhotoViewer({
  reference,
  load,
  onClose,
}: {
  reference: PhotoReference;
  load: (reference: PhotoReference) => Promise<PhotoInput>;
  onClose: () => void;
}) {
  const photo = useQuery({
    queryKey: ["photo", reference.draft, reference.id],
    queryFn: () => load(reference),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  return (
    <Modal animationType="fade" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close photo"
            style={styles.close}
            onPress={onClose}
          >
            <X size={24} color="white" />
          </Pressable>
        </View>
        {photo.data ? (
          <Image
            source={{ uri: `data:image/jpeg;base64,${photo.data.data}` }}
            resizeMode="contain"
            style={styles.viewport}
          />
        ) : (
          <View style={styles.center}>
            {photo.isPending ? (
              <ActivityIndicator color="white" />
            ) : (
              <>
                <Text style={styles.error}>
                  {photo.error?.message ?? "Couldn’t load this photo."}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    void photo.refetch();
                  }}
                  style={styles.close}
                >
                  <Text style={styles.hint}>Retry</Text>
                </Pressable>
              </>
            )}
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "black" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingLeft: 16,
  },
  close: {
    minWidth: 48,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  hint: { color: "white", fontSize: 13 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  error: { color: "white", padding: 24 },
  viewport: { flex: 1, overflow: "hidden" },
});
