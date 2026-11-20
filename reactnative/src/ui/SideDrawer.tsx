import type { ComponentProps, ReactNode } from "react";
import { StyleSheet, useWindowDimensions } from "react-native";
import { Drawer } from "react-native-drawer-layout";

import { BesidePanel, Panel } from "./Screen";
import { useColors } from "./theme";

// A panel kept beside a route's content, off the right edge: swiping the
// content aside, from anywhere on it, reveals the panel, and the content
// stays in view at the panel's side to swipe or press back. The panel stays
// mounted while it is closed, so it opens as it was left.
export function SideDrawer({
  open,
  onOpen,
  onClose,
  closeLabel,
  panel,
  children,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  // What pressing the content beside the open panel says it does, for
  // screen readers.
  closeLabel: string;
  panel: ReactNode;
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const colors = useColors();
  return (
    <Drawer
      open={open}
      onOpen={onOpen}
      onClose={onClose}
      drawerPosition="right"
      drawerType="slide"
      swipeEdgeWidth={width}
      configureGestureHandler={afterNativeScroll}
      overlayStyle={styles.clear}
      overlayAccessibilityLabel={closeLabel}
      drawerStyle={[styles.panel, { borderLeftColor: colors.line }]}
      renderDrawerContent={() => <Panel open={open}>{panel}</Panel>}
    >
      <BesidePanel open={open}>{children}</BesidePanel>
    </Drawer>
  );
}

// The swipe starts well after a native horizontal scroll does, so content
// that scrolls sideways, such as a table, keeps even a quick swipe that
// begins on it. It tolerates as much drift up or down as it needs to start,
// so a slanted flick still counts.
const SWIPE_START = 20;
const SWIPE_DRIFT = 20;
const afterNativeScroll: NonNullable<
  ComponentProps<typeof Drawer>["configureGestureHandler"]
> = (pan) =>
  pan
    .activeOffsetX([-SWIPE_START, SWIPE_START])
    .failOffsetY([-SWIPE_DRIFT, SWIPE_DRIFT]);

const styles = StyleSheet.create({
  // The content beside the panel isn't dimmed.
  clear: { backgroundColor: "transparent" },
  // The panel paints itself; a line marks its edge against the content.
  panel: {
    backgroundColor: "transparent",
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
});
