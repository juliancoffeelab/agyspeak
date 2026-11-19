import { StyleSheet, View } from "react-native";

import { Failure } from "../../ui/Failure";

// A chat that couldn't be opened: the chat shown before stays open. Shows
// the error's details, a retry and a way back.
export function OpenFailure({
  error,
  onRetry,
  onDismiss,
}: {
  error: unknown;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <View style={styles.failure}>
      <Failure
        message="Couldn’t open this chat."
        hint="It couldn’t be read. Your saved chats are kept."
        error={error}
        onRetry={onRetry}
        onDismiss={onDismiss}
      />
    </View>
  );
}

const styles = StyleSheet.create({ failure: { padding: 20 } });
