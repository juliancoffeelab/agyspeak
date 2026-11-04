// A reply's temporary text is a separate external store: token arrivals update
// only its bubble. SQLite and the controller snapshot change when the turn ends.
export class StreamingText {
  private text = "";
  private displayed = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly listeners = new Set<() => void>();

  getSnapshot = () => this.displayed;
  get latest() {
    return this.text;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(text: string) {
    if (this.closed) return;
    this.text = text;
    if (this.timer === null) this.timer = setTimeout(this.flush, 40);
  }
  private flush = () => {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.displayed === this.text) return;
    this.displayed = this.text;
    this.listeners.forEach((listener) => listener());
  };
  close() {
    this.closed = true;
    this.flush();
    this.listeners.clear();
  }
}
