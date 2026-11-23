import { createContext, use } from "react";
import { useColorScheme } from "react-native";

export const PALETTES = {
  light: {
    background: "#faf9f6",
    surface: "#ffffff",
    text: "#20211f",
    muted: "#6b6d66",
    line: "#dedfd8",
    bubble: "#eaece4",
    button: "#252d25",
    buttonText: "#ffffff",
    danger: "#b3261e",
  },
  dark: {
    background: "#191b19",
    surface: "#242724",
    text: "#eeefe8",
    muted: "#a1a79d",
    line: "#363b35",
    bubble: "#2c322b",
    button: "#dfe9d8",
    buttonText: "#1c251b",
    danger: "#f2b8b5",
  },
};

export type ChatColors = typeof PALETTES.light;

// A surface with its own fixed background, such as the photo viewer's black,
// provides the palette that reads on it.
export const FixedColorsContext = createContext<ChatColors | null>(null);

// Theme is read where it is used rather than passed through components.
export function useColors(): ChatColors {
  const fixed = use(FixedColorsContext);
  const scheme = useColorScheme();
  return fixed ?? PALETTES[scheme === "dark" ? "dark" : "light"];
}
