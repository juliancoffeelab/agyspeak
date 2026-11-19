import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Animated,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import X from "lucide-react-native/icons/x";
import { Failure } from "../../ui/Failure";
import { FixedColorsContext, palettes } from "../../ui/theme";
import { PHOTO_PAN_SPEED, shouldDismissPhoto } from "./photoInteraction";
import type { PhotoInput, PhotoReference } from "./storage/contracts";

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
          <ZoomablePhoto photo={photo.data} onClose={onClose} />
        ) : (
          <View style={styles.center}>
            {photo.isPending ? (
              <ActivityIndicator color="white" />
            ) : (
              <View style={styles.details}>
                <FixedColorsContext value={palettes.dark}>
                  <Failure
                    message="Couldn’t load this photo."
                    hint={null}
                    error={photo.error}
                    onRetry={() => void photo.refetch()}
                    onDismiss={null}
                  />
                </FixedColorsContext>
              </View>
            )}
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

type Point = { x: number; y: number };
function points(event: GestureResponderEvent): Point[] {
  return event.nativeEvent.touches.map((touch) => ({
    x: touch.pageX,
    y: touch.pageY,
  }));
}
function midpoint(touches: Point[]): Point {
  return touches.length > 1
    ? {
        x: (touches[0].x + touches[1].x) / 2,
        y: (touches[0].y + touches[1].y) / 2,
      }
    : touches[0];
}
function distance(touches: Point[]) {
  return touches.length > 1
    ? Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y)
    : 0;
}
class PhotoGestures {
  readonly scale = new Animated.Value(1);
  readonly pan = new Animated.ValueXY();
  readonly responder: ReturnType<typeof PanResponder.create>;
  private viewport = { width: 1, height: 1 };
  private transform = { scale: 1, x: 0, y: 0 };
  private gesture = {
    touches: [] as Point[],
    start: { scale: 1, x: 0, y: 0 },
    time: 0,
    moved: false,
    lastTap: 0,
  };
  private dismissing = false;
  private dismissal = { x: 0, y: 0 };
  private settling = false;
  private disposed = false;
  private origin = { x: 0, y: 0 };
  private readonly width: number;
  private readonly height: number;
  resize(viewport: { width: number; height: number }) {
    this.viewport = viewport;
  }
  activate() {
    this.disposed = false;
  }
  dispose() {
    this.disposed = true;
    this.pan.stopAnimation();
    this.scale.stopAnimation();
  }
  constructor(width: number, height: number, onClose: () => void) {
    this.width = width;
    this.height = height;
    const apply = (next: { scale: number; x: number; y: number }) => {
      const viewport = this.viewport;
      const fit = Math.min(
        viewport.width / this.width,
        viewport.height / this.height,
      );
      const maxX = Math.max(
        0,
        (this.width * fit * next.scale - viewport.width) / 2,
      );
      const maxY = Math.max(
        0,
        (this.height * fit * next.scale - viewport.height) / 2,
      );
      next.x = Math.max(-maxX, Math.min(maxX, next.x));
      next.y = Math.max(-maxY, Math.min(maxY, next.y));
      this.transform = next;
      this.scale.setValue(next.scale);
      this.pan.setValue({ x: next.x, y: next.y });
    };
    const begin = (event: GestureResponderEvent) => {
      const touch = event.nativeEvent.touches[0];
      if (touch)
        this.origin = {
          x: touch.pageX - touch.locationX,
          y: touch.pageY - touch.locationY,
        };
      this.gesture.touches = points(event);
      this.gesture.start = { ...this.transform };
    };
    this.responder = PanResponder.create({
      onStartShouldSetPanResponder: () => !this.settling,
      onMoveShouldSetPanResponder: () => !this.settling,
      onPanResponderGrant: (event) => {
        this.dismissing = false;
        begin(event);
        this.gesture.time = event.nativeEvent.timestamp;
        this.gesture.moved = false;
      },
      onPanResponderMove: (event) => {
        const touches = points(event),
          gesture = this.gesture;
        if (!touches.length) return;
        if (touches.length !== gesture.touches.length) {
          this.dismissing = false;
          this.pan.setValue({ x: this.transform.x, y: this.transform.y });
          begin(event);
          gesture.moved = true;
          return;
        }
        const initial = midpoint(gesture.touches),
          current = midpoint(touches);
        const dx = current.x - initial.x,
          dy = current.y - initial.y;
        if (
          touches.length === 1 &&
          gesture.start.scale <= 1 &&
          dy > 8 &&
          dy > Math.abs(dx)
        )
          this.dismissing = true;
        if (this.dismissing && touches.length === 1) {
          gesture.moved = true;
          this.dismissal = { x: dx * 0.25, y: Math.max(0, dy) };
          this.pan.setValue(this.dismissal);
          return;
        }
        const nextScale =
          touches.length > 1
            ? Math.max(
                1,
                Math.min(
                  6,
                  (gesture.start.scale * distance(touches)) /
                    Math.max(1, distance(gesture.touches)),
                ),
              )
            : gesture.start.scale;
        if (
          touches.length > 1 ||
          Math.hypot(current.x - initial.x, current.y - initial.y) > 6
        )
          gesture.moved = true;
        const ratio = nextScale / gesture.start.scale;
        const center = {
          x: this.origin.x + this.viewport.width / 2,
          y: this.origin.y + this.viewport.height / 2,
        };
        if (touches.length === 1) {
          apply({
            scale: nextScale,
            x: gesture.start.x + dx * PHOTO_PAN_SPEED,
            y: gesture.start.y + dy * PHOTO_PAN_SPEED,
          });
          return;
        }
        apply({
          scale: nextScale,
          x:
            current.x -
            center.x -
            (initial.x - center.x - gesture.start.x) * ratio,
          y:
            current.y -
            center.y -
            (initial.y - center.y - gesture.start.y) * ratio,
        });
      },
      onPanResponderRelease: (event, state) => {
        if (this.dismissing) {
          const dismiss = shouldDismissPhoto(
            this.dismissal.y,
            state.vy,
            this.viewport.height,
          );
          this.settling = true;
          const animation = dismiss
            ? Animated.timing(this.pan, {
                toValue: { x: this.dismissal.x, y: this.viewport.height },
                duration: 180,
                useNativeDriver: true,
              })
            : Animated.spring(this.pan, {
                toValue: { x: 0, y: 0 },
                speed: 22,
                bounciness: 4,
                useNativeDriver: true,
              });
          animation.start(({ finished }) => {
            this.settling = false;
            if (finished && dismiss && !this.disposed) onClose();
          });
          this.gesture.lastTap = 0;
          return;
        }
        const gesture = this.gesture,
          now = event.nativeEvent.timestamp;
        if (!gesture.moved && now - gesture.time < 250) {
          if (now - gesture.lastTap < 300) {
            apply(
              this.transform.scale > 1
                ? { scale: 1, x: 0, y: 0 }
                : { scale: 2.5, x: 0, y: 0 },
            );
            gesture.lastTap = 0;
          } else gesture.lastTap = now;
        } else gesture.lastTap = 0;
      },
      onPanResponderTerminate: () => {
        this.pan.setValue({ x: this.transform.x, y: this.transform.y });
        this.dismissing = false;
      },
      onPanResponderTerminationRequest: () => false,
    });
  }
}
function ZoomablePhoto({
  photo,
  onClose,
}: {
  photo: PhotoInput;
  onClose: () => void;
}) {
  const gestures = useMemo(
    () => new PhotoGestures(photo.width, photo.height, onClose),
    [photo.width, photo.height, onClose],
  );
  useEffect(() => {
    gestures.activate();
    return () => gestures.dispose();
  }, [gestures]);
  return (
    <View
      style={styles.viewport}
      onLayout={(event) => {
        gestures.resize(event.nativeEvent.layout);
      }}
      {...gestures.responder.panHandlers}
    >
      <Animated.Image
        pointerEvents="none"
        source={{ uri: `data:image/jpeg;base64,${photo.data}` }}
        resizeMode="contain"
        style={[
          StyleSheet.absoluteFill,
          {
            transform: [
              { translateX: gestures.pan.x },
              { translateY: gestures.pan.y },
              { scale: gestures.scale },
            ],
          },
        ]}
      />
    </View>
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  details: { alignSelf: "stretch", padding: 24 },
  viewport: { flex: 1, overflow: "hidden" },
});
