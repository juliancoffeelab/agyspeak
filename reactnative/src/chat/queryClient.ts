import { QueryClient, focusManager } from "@tanstack/react-query";
import { AppState } from "react-native";

focusManager.setEventListener((setFocused) => {
  setFocused(AppState.currentState === "active");
  const subscription = AppState.addEventListener("change", (state) =>
    setFocused(state === "active"),
  );
  return () => subscription.remove();
});

// Only the public model catalog is written to disk. Usage and credentials stay in memory.
export const queryClient = new QueryClient();
