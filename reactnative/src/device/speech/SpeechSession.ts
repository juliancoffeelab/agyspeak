import type { AudioArbiter } from "../audio.ts";
import type { SpeechLanguage, SpeechSelection } from "./language";

export type SpeechOutcome = "finished" | "stopped";

type SpeechPort = {
  // Resolves the voice for a language; null asks for the device default.
  prepare: (language: SpeechLanguage | null) => Promise<SpeechSelection>;
  stop: () => Promise<void>;
  speak: (prose: string, selection: SpeechSelection) => Promise<SpeechOutcome>;
  onError: (message: string) => void;
  // Recording holds the audio arbiter; speech never starts while it does.
  audio: AudioArbiter;
};
export class SpeechUnavailableError extends Error {}

// Reads prepared prose aloud, one utterance at a time. `playing` is the
// caller's key for the utterance in progress, so callers can show it.
export class SpeechSession {
  private readonly port: SpeechPort;
  private state: { playing: number | null; recording: boolean } = {
    playing: null,
    recording: false,
  };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private pendingStops = 0;
  private stopFailed = false;
  private stopping: Promise<void> = Promise.resolve();
  constructor(port: SpeechPort) {
    this.port = port;
    this.state.recording = port.audio.holds();
    // The session lives as long as its arbiter; neither is disposed apart.
    port.audio.subscribe(() => {
      const recording = port.audio.holds();
      if (recording !== this.state.recording) this.publish({ recording });
    });
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
  async stop(): Promise<boolean> {
    if (
      this.state.playing === null &&
      this.pendingStops === 0 &&
      !this.stopFailed
    )
      return true;
    const generation = ++this.generation;
    this.publish({ playing: null });
    try {
      await this.silence();
      return true;
    } catch {
      if (generation === this.generation)
        this.port.onError("Couldn’t stop speech. Try again.");
      return false;
    }
  }
  // Replaces whatever is playing. Nothing starts while recording.
  async play(key: number, prose: string, language: SpeechLanguage | null) {
    if (this.state.recording) return;
    const generation = ++this.generation;
    this.publish({ playing: key });
    const finish = () => {
      if (generation === this.generation) {
        this.generation++;
        this.publish({ playing: null });
      }
    };
    try {
      await this.silence();
      if (generation !== this.generation || this.state.recording) return;
      const selection = await this.port.prepare(language);
      if (generation !== this.generation || this.state.recording) return;
      await this.port.speak(prose, selection);
      finish();
    } catch (cause) {
      if (generation !== this.generation) return;
      finish();
      this.port.onError(
        cause instanceof SpeechUnavailableError
          ? cause.message
          : "Couldn’t read aloud. Check that a text-to-speech voice is installed on your device.",
      );
    }
  }
}
