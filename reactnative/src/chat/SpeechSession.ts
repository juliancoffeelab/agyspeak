import type { SpeechLanguage, SpeechSelection } from "./speechLanguage";
import { markdownToSpeechText } from "./speechText.ts";

export type SpeechOutcome = "finished" | "stopped";

type SpeechPort = {
  prepare?: (language?: SpeechLanguage) => Promise<SpeechSelection | void>;
  stop: () => Promise<void>;
  speak: (prose: string, selection?: SpeechSelection) => Promise<SpeechOutcome>;
  onError: (message: string) => void;
};
export class SpeechUnavailableError extends Error {}

export class SpeechSession {
  private readonly port: SpeechPort;
  private state: {
    messageId: number | null;
    recording: boolean;
    languages: ReadonlyMap<number, SpeechLanguage>;
  } = {
    messageId: null,
    recording: false,
    languages: new Map(),
  };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private pendingStops = 0;
  private stopFailed = false;
  private stopping: Promise<void> = Promise.resolve();
  constructor(port: SpeechPort) {
    this.port = port;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<typeof this.state>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener());
  }
  private silence() {
    this.pendingStops++;
    const stop = this.stopping
      .then(async () => {
        try {
          await this.port.stop();
          this.stopFailed = false;
        } catch (cause) {
          this.stopFailed = true;
          throw cause;
        }
      })
      .finally(() => {
        this.pendingStops--;
      });
    this.stopping = stop.catch(() => {});
    return stop;
  }
  setRecording(recording: boolean) {
    if (recording !== this.state.recording) this.publish({ recording });
  }
  async stop(): Promise<boolean> {
    if (
      this.state.messageId === null &&
      this.pendingStops === 0 &&
      !this.stopFailed
    )
      return true;
    const generation = ++this.generation;
    this.publish({ messageId: null });
    try {
      await this.silence();
      return true;
    } catch {
      if (generation === this.generation)
        this.port.onError("Couldn’t stop speech. Try again.");
      return false;
    }
  }
  setLanguage(messageId: number, language: SpeechLanguage | undefined) {
    const languages = new Map(this.state.languages);
    if (language) languages.set(messageId, language);
    else languages.delete(messageId);
    this.publish({ languages });
    if (this.state.messageId === messageId) void this.stop();
  }
  async toggle(messageId: number, markdown: string) {
    if (this.state.recording) return;
    if (this.state.messageId === messageId) {
      await this.stop();
      return;
    }
    const prose = markdownToSpeechText(markdown);
    if (!prose) {
      this.port.onError("There’s no spoken text in this response.");
      return;
    }
    const generation = ++this.generation;
    const language = this.state.languages.get(messageId);
    this.publish({ messageId });
    const finish = () => {
      if (generation === this.generation) {
        this.generation++;
        this.publish({ messageId: null });
      }
    };
    const fail = (message?: string) => {
      if (generation !== this.generation) return;
      finish();
      this.port.onError(
        message ??
          "Couldn’t read the response. Check that a text-to-speech voice is installed on your device.",
      );
    };
    try {
      await this.silence();
      if (generation !== this.generation || this.state.recording) return;
      const selection = (await this.port.prepare?.(language)) ?? { language };
      if (generation !== this.generation || this.state.recording) return;
      await this.port.speak(prose, selection);
      finish();
    } catch (cause) {
      fail(cause instanceof SpeechUnavailableError ? cause.message : undefined);
    }
  }
}
