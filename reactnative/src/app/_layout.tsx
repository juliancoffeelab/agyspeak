import { QueryClientProvider } from "@tanstack/react-query";
import {
  CardStyleInterpolators,
  Stack,
  type StackNavigationOptions,
} from "expo-router/js-stack";
import { StatusBar } from "expo-status-bar";
import { Easing, useColorScheme } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";

import { AppScope } from "../application/AppScope";
import { queryClient } from "../application/queryClient";
import { useResources } from "../application/useResources";
import { OverlayHost } from "../ui/Overlay";

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <KeyboardProvider>
        <Root />
      </KeyboardProvider>
    </QueryClientProvider>
  );
}

// History and Settings slide over the chat, as the screens they replaced did.
const SLIDE_MS = 200;
const overChat: StackNavigationOptions = {
  gestureEnabled: false,
  cardStyleInterpolator: CardStyleInterpolators.forVerticalIOS,
  transitionSpec: {
    open: {
      animation: "timing",
      config: { duration: SLIDE_MS, easing: Easing.bezier(0.33, 1, 0.68, 1) },
    },
    close: {
      animation: "timing",
      config: { duration: SLIDE_MS, easing: Easing.bezier(0.32, 0, 0.67, 0) },
    },
  },
};

// Navigation and each destination's header show from the first frame; the
// destinations fill in as their resources open.
function Root() {
  const { startup, retry } = useResources(queryClient);
  const dark = useColorScheme() === "dark";
  return (
    <>
      <StatusBar style={dark ? "light" : "dark"} />
      <AppScope startup={startup} retry={retry}>
        <OverlayHost>
          <Stack screenOptions={{ headerShown: false }}>
            {/* The one chat destination; the coordinator owns which chat it
                shows. */}
            <Stack.Screen name="index" />
            <Stack.Screen name="history" options={overChat} />
            <Stack.Screen name="settings" options={overChat} />
          </Stack>
        </OverlayHost>
      </AppScope>
    </>
  );
}
