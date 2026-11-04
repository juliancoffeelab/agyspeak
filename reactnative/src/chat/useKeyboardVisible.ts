import { useSyncExternalStore } from "react";
import { Keyboard } from "react-native";

function subscribe(notify: () => void) {
  const show = Keyboard.addListener("keyboardDidShow", notify);
  const hide = Keyboard.addListener("keyboardDidHide", notify);
  return () => {
    show.remove();
    hide.remove();
  };
}
const getSnapshot = () => Keyboard.isVisible();
export function useKeyboardVisible() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
