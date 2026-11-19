// A reply's temporary text is a separate external store: token arrivals update
// only its own views. SQLite and the controller snapshot change when the turn
// ends.
//
// Arriving text is shown a word at a time, at most once per frame: a word
// still being written is held back until it is whole. So is a line that only
// means something whole (see `heldLine`). The end of the reply shows the
// rest.

// Text may be cut after whitespace, and after a character of a script that
// is written without spaces between words: Thai, Lao, Myanmar, Khmer,
// Chinese, Japanese, and their full-width punctuation.
const CUT_AFTER =
  /[\s\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF\u2E80-\uA4CF\uF900-\uFAFF\uFF00-\uFFEF]/;
// A word is held back while it is at most this long. Longer runs without a
// place to cut (a URL, a script not listed above) are shown as they come.
const LONGEST_HELD_WORD = 40;
// A line that is so far only a marker: of a list, a quote, a fence, a
// heading or its underline.
const MARKER = /^([-*+>#=`~]+|\d+[.)]?)?\s*$/;

// Whether an unfinished line of Markdown is held back until it ends or says
// more: a table row, and a line that is only a marker, which would be drawn
// as something else until its text arrives.
function heldLine(unfinished: string) {
  const line = unfinished.trimStart();
  return line.startsWith("|") || (line.length <= 8 && MARKER.test(line));
}
export class StreamingText {
  private text = "";
  // How much of the text is shown.
  private shown = 0;
  private waiting = false;
  private closed = false;
  private readonly listeners = new Set<() => void>();
  // The text shown so far.
  getSnapshot = () => this.text.slice(0, this.shown);
  get latest() {
    return this.text;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  // `text` is the whole reply so far.
  update(text: string) {
    if (this.closed) return;
    this.text = text;
    this.schedule();
  }
  private schedule() {
    if (this.waiting) return;
    this.waiting = true;
    requestAnimationFrame(this.step);
  }
  private step = () => {
    this.waiting = false;
    if (this.closed) return;
    const end = this.cut();
    if (end > this.shown) this.reveal(end);
  };
  // How much of the text can be shown now.
  private cut() {
    const text = this.text;
    const line = text.lastIndexOf("\n") + 1;
    if (heldLine(text.slice(line))) return line;
    const earliest = Math.max(line, text.length - LONGEST_HELD_WORD);
    let end = text.length;
    while (end > earliest && !CUT_AFTER.test(text[end - 1])) end -= 1;
    if (end > earliest || earliest === line) return end;
    // No place to cut in reach: everything, but never half of a character.
    const last = text.charCodeAt(text.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? text.length - 1 : text.length;
  }
  private reveal(end: number) {
    this.shown = end;
    this.listeners.forEach((listener) => listener());
  }
  close() {
    this.closed = true;
    if (this.shown < this.text.length) this.reveal(this.text.length);
    this.listeners.clear();
  }
}
