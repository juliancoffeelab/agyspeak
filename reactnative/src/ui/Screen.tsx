import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Keyboard, StyleSheet } from "react-native";
import { useIsFocused } from "expo-router";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import {
  KeyboardController,
  KeyboardEvents,
  KeyboardStickyView,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "./theme";

// The one owner of a layer's edges: the safe area and the keyboard. A layer
// is a route or an overlay; every one of them is laid out by a `Screen`.
//
// A layer follows the keyboard only when its own input raised it: it must be
// the top layer when the keyboard starts to open, and it keeps following
// until the keyboard has closed. So a layer that opens or closes while the
// keyboard moves never reacts to a keyboard that isn't its own.

// Whether an overlay is the top layer; null in a route.
export const OverlayTopContext = createContext<boolean | null>(null);
// Whether an overlay covers the routes.
export const CoveredContext = createContext(false);

type Layer = {
  follows: boolean;
  // The height of what is docked to the layer's bottom edge.
  dockHeight: SharedValue<number>;
};
const LayerContext = createContext<Layer | null>(null);

function useLayer() {
  const layer = use(LayerContext);
  if (!layer) throw new Error("Rendered outside a Screen.");
  return layer;
}

function subscribeToKeyboard(notify: () => void) {
  const show = KeyboardEvents.addListener("keyboardWillShow", notify);
  const hide = KeyboardEvents.addListener("keyboardDidHide", notify);
  return () => {
    show.remove();
    hide.remove();
  };
}
// Open from the moment the keyboard starts to show until it has hidden.
const keyboardOpen = () => KeyboardController.isVisible();

function useFollows(top: boolean) {
  const open = useSyncExternalStore(subscribeToKeyboard, keyboardOpen);
  const [follows, setFollows] = useState(top && !open);
  // Ownership changes hands only while the keyboard is closed.
  if (!open && follows !== top) setFollows(top);
  return follows;
}

type ScreenProps = {
  // `pad` keeps everything above the keyboard by shrinking the layer.
  // `dock` leaves the layer its size: a `KeyboardDock` rides the keyboard
  // and a docked list makes room for it.
  keyboard: "pad" | "dock";
  background: string;
  children: ReactNode;
};

export function Screen(props: ScreenProps) {
  const overlayTop = use(OverlayTopContext);
  return overlayTop === null ? (
    <RouteFrame {...props} />
  ) : (
    <Frame top={overlayTop} {...props} />
  );
}

function RouteFrame(props: ScreenProps) {
  const focused = useIsFocused();
  const covered = use(CoveredContext);
  // Leaving a route closes its keyboard, once, whatever led away from it.
  useEffect(() => {
    if (!focused) Keyboard.dismiss();
  }, [focused]);
  return <Frame top={focused && !covered} {...props} />;
}

function Frame({
  top,
  keyboard,
  background,
  children,
}: ScreenProps & { top: boolean }) {
  const insets = useSafeAreaInsets();
  const follows = useFollows(top);
  const { height } = useReanimatedKeyboardAnimation();
  const dockHeight = useSharedValue(0);
  const pads = keyboard === "pad" && follows;
  const bottom = insets.bottom;
  // The keyboard's height is negative: the distance it has risen.
  const edge = useAnimatedStyle(() => ({
    paddingBottom: pads ? Math.max(bottom, -height.get()) : bottom,
  }));
  const layer = useMemo(() => ({ follows, dockHeight }), [follows, dockHeight]);
  return (
    <LayerContext value={layer}>
      <Animated.View
        style={[
          styles.fill,
          {
            backgroundColor: background,
            paddingTop: insets.top,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          },
          edge,
        ]}
      >
        {children}
      </Animated.View>
    </LayerContext>
  );
}

// What stays at the bottom of a `dock` screen and rides the keyboard: it
// lies over the screen's content instead of taking space from it, so
// neither its own growth nor the keyboard resizes anything.
export function KeyboardDock({ children }: { children: ReactNode }) {
  const { follows, dockHeight } = useLayer();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  return (
    <KeyboardStickyView
      enabled={follows}
      // The screen already stands clear of the bottom inset.
      offset={{ closed: 0, opened: insets.bottom }}
      onLayout={(event) => dockHeight.set(event.nativeEvent.layout.height)}
      style={[styles.dock, { backgroundColor: colors.background }]}
    >
      {children}
    </KeyboardStickyView>
  );
}

// Content of a `dock` screen that doesn't scroll, kept clear of the dock.
export function AboveDock({ children }: { children: ReactNode }) {
  const { dockHeight } = useLayer();
  const clearance = useAnimatedStyle(() => ({
    paddingBottom: dockHeight.get(),
  }));
  return (
    <Animated.View style={[styles.fill, clearance]}>{children}</Animated.View>
  );
}

// What a keyboard-aware list under the dock needs: it fills the screen and
// makes room for the dock and the keyboard in its content, not its size.
// Only a list showing its end is lifted with them; one scrolled back to
// older content keeps what is being read in place.
export function useDockedList() {
  const { follows, dockHeight } = useLayer();
  const insets = useSafeAreaInsets();
  return {
    keyboardOffset: insets.bottom,
    contentInsetEndAdjustment: dockHeight,
    freeze: !follows,
    keyboardLiftBehavior: "whenAtEnd" as const,
  };
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  dock: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
