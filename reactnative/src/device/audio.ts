// The microphone and speech output are exclusive across every recording
// session, including one being replaced. Claims are served in order: each
// claim's `ready` settles once every earlier claim has been released, and an
// owner releases only after its native teardown has settled.
export type AudioClaim = {
  readonly ready: Promise<void>;
};

export function createAudioArbiter() {
  const held = new Map<AudioClaim, () => void>();
  let released: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    claim(): AudioClaim {
      let release!: () => void;
      const own = new Promise<void>((resolve) => {
        release = resolve;
      });
      const claim = Object.freeze({ ready: released });
      released = Promise.all([released, own]).then(() => undefined);
      held.set(claim, release);
      notify();
      return claim;
    },
    release(claim: AudioClaim) {
      const release = held.get(claim);
      if (!release) return;
      held.delete(claim);
      release();
      notify();
    },
    // Whether a recording holds the microphone.
    holds: () => held.size > 0,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type AudioArbiter = ReturnType<typeof createAudioArbiter>;
