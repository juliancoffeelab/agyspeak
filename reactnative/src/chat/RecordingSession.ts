export type RecordingClip = { uri: string; format: string; durationMillis?: number; levels?: number[] };
export type RecordingState = {
  phase: 'idle' | 'preparing' | 'recording' | 'ready' | 'sending';
  clip: RecordingClip | null;
  durationMillis: number;
  levels: number[];
  error: string | null;
};
export type RecordingPort = {
  permission: () => Promise<boolean>;
  prepare: () => Promise<void>;
  record: () => void;
  stop: () => Promise<void>;
  status: () => { isRecording: boolean; durationMillis: number; metering?: number };
  uri: () => string | null;
  remove: (uri: string) => void;
};
type Submit = (clip: RecordingClip, signal: AbortSignal) => Promise<boolean>;
const empty = (): RecordingState => ({ phase: 'idle', clip: null, durationMillis: 0, levels: [], error: null });

// Own native operations and invalidate awaited work when the screen goes away.
export class RecordingSession {
  private state = empty();
  private readonly listeners = new Set<() => void>();
  private active = true;
  private generation = 0;
  private work: Promise<unknown> = Promise.resolve();
  private sending: AbortController | null = null;
  private readonly port: RecordingPort;
  constructor(port: RecordingPort) { this.port = port; }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(update: Partial<RecordingState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach(listener => listener());
  }
  private queue(action: () => Promise<boolean>) {
    const task = this.work.then(action).catch(cause => {
      this.publish({ phase: this.state.clip ? 'ready' : 'idle', error: cause instanceof Error ? cause.message : 'Recording failed. Please try again.' });
      return false;
    });
    this.work = task;
    return task;
  }
  private current(ticket: number) { return this.active && ticket === this.generation; }

  setActive(active: boolean) {
    this.active = active;
    if (!active) {
      this.generation++;
      this.sending?.abort();
      void this.queue(async () => { await this.finishCapture(); return true; });
    }
  }

  start() {
    const ticket = this.generation;
    return this.queue(async () => {
      if (!this.current(ticket) || this.state.phase !== 'idle') return false;
      this.publish({ ...empty(), phase: 'preparing' });
      if (!await this.port.permission()) throw new Error('Allow microphone access in Android settings to record a voice message.');
      if (!this.current(ticket)) { this.publish(empty()); return false; }
      let started = false;
      try {
        await this.port.prepare();
        if (!this.current(ticket)) return false;
        this.port.record();
        started = true;
        this.publish({ phase: 'recording' });
        return true;
      } finally {
        if (!started) {
          // Preparation may finish after navigation or unmount. Never start it.
          try { await this.port.stop(); } catch { /* Native lifetime may already have ended. */ }
          const uri = this.port.uri();
          if (uri) this.port.remove(uri);
          this.publish(empty());
        }
      }
    });
  }

  sample() {
    if (this.state.phase !== 'recording') return;
    try {
      const status = this.port.status();
      this.publish({
        durationMillis: Math.max(this.state.durationMillis, status.durationMillis),
        levels: status.metering === undefined ? this.state.levels : [...this.state.levels, Math.pow(10, status.metering / 40)],
      });
      if (!status.isRecording) void this.queue(async () => { await this.finishCapture(); return true; });
    } catch {
      this.setActive(false);
      this.publish({ error: 'Recording was interrupted. Please try again.' });
    }
  }

  private async finishCapture() {
    if (this.state.phase !== 'recording') return;
    const status = this.port.status();
    const durationMillis = Math.max(this.state.durationMillis, status.durationMillis);
    if (status.isRecording) await this.port.stop();
    const uri = this.port.uri();
    if (!uri) throw new Error('No recording was saved. Please try again.');
    this.publish({ phase: 'ready', durationMillis, clip: { uri, format: 'm4a', durationMillis, levels: this.state.levels } });
  }

  pick(select: () => Promise<RecordingClip | null>) {
    const ticket = this.generation;
    return this.queue(async () => {
      if (!this.current(ticket) || this.state.phase !== 'idle') return false;
      this.publish({ phase: 'preparing', error: null });
      const clip = await select();
      if (!clip) { this.publish(empty()); return false; }
      if (!this.current(ticket)) { this.port.remove(clip.uri); this.publish(empty()); return false; }
      this.publish({ phase: 'ready', clip, durationMillis: clip.durationMillis ?? 0, levels: clip.levels ?? [] });
      return true;
    });
  }

  send(submit: Submit) {
    const ticket = this.generation;
    return this.queue(async () => {
      if (!this.current(ticket)) return false;
      await this.finishCapture();
      const clip = this.state.clip;
      if (!clip || !this.current(ticket)) return false;
      const abort = new AbortController();
      this.sending = abort;
      this.publish({ phase: 'sending', error: null });
      try {
        const accepted = await submit(clip, abort.signal);
        if (accepted) {
          this.publish(empty());
          try { this.port.remove(clip.uri); } catch { /* Accepted turns own their durable audio. */ }
        } else this.publish({ phase: 'ready' });
        return accepted;
      } finally { this.sending = null; }
    });
  }

  discard() {
    this.generation++;
    this.sending?.abort();
    return this.queue(async () => {
      await this.finishCapture();
      const uri = this.state.clip?.uri;
      if (uri) this.port.remove(uri);
      this.publish(empty());
      return true;
    });
  }
}
