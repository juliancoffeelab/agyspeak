import { StyleSheet } from "react-native";

export const screenStyles = StyleSheet.create({
  screen: { flex: 1 },
  empty: { flex: 1, justifyContent: "center", paddingBottom: 48 },
  emptyTitle: {
    fontSize: 30,
    lineHeight: 38,
    fontWeight: "600",
    letterSpacing: -1,
  },
  emptyHint: { fontSize: 15, lineHeight: 23, marginTop: 12 },
});
