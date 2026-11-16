import { queryOptions } from "@tanstack/react-query";
import * as Speech from "expo-speech";
import { SpeechUnavailableError } from "./SpeechSession";

export const speechVoicesQuery = queryOptions({
  queryKey: ["speech", "voices"],
  staleTime: Infinity,
  gcTime: Infinity,
  retry: false,
  queryFn: async () => {
    const voices = await Speech.getAvailableVoicesAsync();
    if (!voices.length)
      throw new SpeechUnavailableError(
        "No text-to-speech voices are available on this device.",
      );
    return voices;
  },
});
