import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  BackHandler,
  Keyboard,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CoveredContext, OverlayTopContext, Screen } from "./Screen";
import { useColors } from "./theme";

// Everything shown over the routes: dialogs, sheets, pickers and full-screen
// tools. Overlays render in the app's own window, above the navigator, so
// opening one never moves window focus. Opening one closes the keyboard once;
// only an overlay's own input raises it again.

type OverlayProps = {
  // `center` is a card and `bottom` a sheet, both over a dimmed backdrop
  // that closes them. `fill` is the whole screen, laid out by its own
  // `Screen`. `popover` is a small card its owner places, with nothing dimmed;
  // it appears and goes at once, where the others fade.
  placement: "center" | "bottom" | "fill" | "popover";
  // What the backdrop says it does, for screen readers.
  closeLabel: string;
  // Closing by the backdrop or the back button.
  onClose: () => void;
  children: ReactNode;
};
// A closing entry fades out before it is removed; a popover is removed at
// once.
type Entry = OverlayProps & { id: string; closing: boolean };

const HostContext = createContext<{
  show: (entry: Omit<Entry, "closing">) => void;
  hide: (id: string) => void;
} | null>(null);

const SCRIM = "rgba(0,0,0,0.4)";
const FADE_MS = 150;

// Mounted once, around the navigator.
export function OverlayHost({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const host = useMemo(
    () => ({
      show: (shown: Omit<Entry, "closing">) => {
        const entry = { ...shown, closing: false };
        setEntries((current) =>
          current.some((other) => other.id === entry.id)
            ? current.map((other) => (other.id === entry.id ? entry : other))
            : [...current, entry],
        );
      },
      hide: (id: string) => {
        setEntries((current) =>
          current.flatMap((entry) =>
            entry.id !== id
              ? [entry]
              : entry.placement === "popover"
                ? []
                : [{ ...entry, closing: true }],
          ),
        );
        setTimeout(
          () =>
            setEntries((current) => current.filter((entry) => entry.id !== id)),
          FADE_MS,
        );
      },
    }),
    [],
  );
  const top = entries.findLast((entry) => !entry.closing);
  const covered = top !== undefined;
  return (
    <HostContext value={host}>
      <CoveredContext value={covered}>
        <View
          style={styles.fill}
          importantForAccessibility={covered ? "no-hide-descendants" : "auto"}
        >
          {children}
        </View>
      </CoveredContext>
      {entries.map((entry) => (
        <Shown key={entry.id} entry={entry} top={entry === top} />
      ))}
    </HostContext>
  );
}

// Shows its children over the routes for as long as it is mounted.
export function Overlay(props: OverlayProps) {
  const host = use(HostContext);
  if (!host) throw new Error("Overlay rendered outside its host.");
  const id = useId();
  // The host renders what this component was last given.
  useLayoutEffect(() => {
    host.show({ ...props, id });
  });
  useLayoutEffect(() => () => host.hide(id), [host, id]);
  return null;
}

function Shown({ entry, top }: { entry: Entry; top: boolean }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const close = useEffectEvent(() => entry.onClose());
  useEffect(() => Keyboard.dismiss(), []);
  const { closing } = entry;
  const fades = entry.placement !== "popover";
  const opacity = useSharedValue(fades ? 0 : 1);
  useEffect(() => {
    if (fades) opacity.set(withTiming(closing ? 0 : 1, { duration: FADE_MS }));
  }, [closing, fades, opacity]);
  const fade = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  useEffect(() => {
    if (!top) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        close();
        return true;
      },
    );
    return () => subscription.remove();
  }, [top]);

  const backdrop = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry.closeLabel}
      onPress={entry.onClose}
      style={StyleSheet.absoluteFill}
    />
  );
  return (
    <Animated.View
      pointerEvents={closing ? "none" : "auto"}
      style={[StyleSheet.absoluteFill, fade]}
    >
      <OverlayTopContext value={top}>
        {entry.placement === "fill" || entry.placement === "popover" ? (
          entry.children
        ) : entry.placement === "center" ? (
          <Screen keyboard="pad" background={SCRIM}>
            <View style={styles.center}>
              {backdrop}
              <View
                accessibilityViewIsModal
                onAccessibilityEscape={entry.onClose}
                style={[styles.card, { backgroundColor: colors.surface }]}
              >
                {entry.children}
              </View>
            </View>
          </Screen>
        ) : (
          <View style={[styles.fill, styles.bottom]}>
            {backdrop}
            <View
              accessibilityViewIsModal
              onAccessibilityEscape={entry.onClose}
              style={[
                styles.sheet,
                {
                  backgroundColor: colors.surface,
                  paddingBottom: 16 + insets.bottom,
                  paddingLeft: 16 + insets.left,
                  paddingRight: 16 + insets.right,
                },
              ]}
            >
              {entry.children}
            </View>
          </View>
        )}
      </OverlayTopContext>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  // A card is as tall as its content, and no taller than the room above the
  // keyboard.
  card: {
    width: "100%",
    maxWidth: 400,
    flexShrink: 1,
    borderRadius: 20,
    overflow: "hidden",
  },
  bottom: { justifyContent: "flex-end", backgroundColor: SCRIM },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 16,
  },
});
