export const palettes = {
  light: {
    background: "#faf9f6",
    surface: "#ffffff",
    text: "#20211f",
    muted: "#6b6d66",
    line: "#dedfd8",
    bubble: "#eaece4",
    button: "#252d25",
    buttonText: "#ffffff",
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
  },
};

export type ChatColors = typeof palettes.light;
