import { speechChunks } from "./speechText.ts";
import type { SpeechOutcome } from "./SpeechSession";
import type { SpeechSelection } from "./speechLanguage";

type NativeSpeech = {
  maxLength: number;
  speak: (
    text: string,
    selection: SpeechSelection | undefined,
    callbacks: {
      onDone: () => void;
      onStopped: () => void;
      onError: () => void;
    },
  ) => void;
  stop: () => Promise<void>;
};

// Own settlement here: native engines may omit onStopped after Stop.
export class PromiseSpeech {
  private readonly native: NativeSpeech;
  private pending?: { stop: () => void };

  constructor(native: NativeSpeech) {
    this.native = native;
  }

  speak = async (
    text: string,
    selection?: SpeechSelection,
  ): Promise<SpeechOutcome> => {
    this.pending?.stop();
    let stopped = false;
    let stopChunk: (() => void) | undefined;
    const job = {
      stop: () => {
        stopped = true;
        stopChunk?.();
      },
    };
    this.pending = job;
    try {
      for (const chunk of speechChunks(text, this.native.maxLength)) {
        if (stopped) return "stopped";
        const outcome = await new Promise<SpeechOutcome>((resolve, reject) => {
          let settled = false;
          const settle = (result: SpeechOutcome | Error) => {
            if (settled) return;
            settled = true;
            stopChunk = undefined;
            if (result instanceof Error) reject(result);
            else resolve(result);
          };
          stopChunk = () => settle("stopped");
          try {
            this.native.speak(chunk, selection, {
              onDone: () => settle("finished"),
              onStopped: () => settle("stopped"),
              onError: () => settle(new Error("Speech failed")),
            });
          } catch (cause) {
            settle(cause instanceof Error ? cause : new Error("Speech failed"));
          }
        });
        if (stopped || outcome === "stopped") return "stopped";
      }
      return "finished";
    } finally {
      if (this.pending === job) this.pending = undefined;
    }
  };

  stop = async (): Promise<void> => {
    this.pending?.stop();
    await this.native.stop();
  };
}
