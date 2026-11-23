// Where a reply's Markdown can be cut and joined again. A clean break is the
// start of a block: a line after a blank line, outside a fenced code block,
// and never right after a heading, which stays with the block it heads.

// A cut looks back over at most this fraction of what the request wrote.
const LOOK_BACK_FRACTION = 1 / 5;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;

type Lines = {
  // Each line's text and where it starts in the text.
  lines: string[];
  starts: number[];
  // The fence line open at each line's start, or null outside a fence.
  open: (string | null)[];
};

function lines(text: string): Lines {
  const lines = text.split("\n");
  const starts: number[] = [];
  const open: (string | null)[] = [];
  let at = 0;
  let fence: string | null = null;
  for (const line of lines) {
    starts.push(at);
    open.push(fence);
    at += line.length + 1;
    const marker = FENCE.exec(line)?.[1];
    if (marker === undefined) continue;
    if (fence === null) fence = line;
    else {
      const opener = FENCE.exec(fence)![1];
      if (
        marker[0] === opener[0] &&
        marker.length >= opener.length &&
        line.trim() === marker
      )
        fence = null;
    }
  }
  return { lines, starts, open };
}

const blank = (line: string) => line.trim() === "";

// Where to cut `text`, whose part from `from` is what the request being cut
// wrote, so its unfinished last block is dropped: the last clean break within
// the look-back, else the last line end in it that doesn't follow a heading,
// else the text's end.
export function cleanBreak(text: string, from: number): number {
  const earliest =
    text.length - Math.floor((text.length - from) * LOOK_BACK_FRACTION);
  const { lines: all, starts, open } = lines(text);
  let lineEnd: number | null = null;
  for (let index = all.length - 1; index >= 1; index--) {
    const at = starts[index];
    if (at < earliest) break;
    // The line the text before `at` ends with that isn't blank.
    let before = index - 1;
    while (before > 0 && blank(all[before])) before--;
    const heading = open[before] === null && HEADING.test(all[before]);
    if (!heading) lineEnd ??= at;
    if (open[index] !== null || !blank(all[index - 1])) continue;
    if (!heading) return at;
    // A heading stays with its block: the cut moves before it.
    if (before > 0 && starts[before] >= earliest && blank(all[before - 1]))
      return starts[before];
  }
  return lineEnd ?? text.length;
}

// Whether `text` ends where a block does: after a blank line, outside a
// fenced code block. A reply cut at a clean break does, and so does one with
// no text yet; what follows it starts a block of its own.
export function endsBlock(text: string): boolean {
  if (text === "") return true;
  const { lines: all, open } = lines(text);
  const last = all.length - 1;
  return (
    last >= 1 && all[last] === "" && open[last] === null && blank(all[last - 1])
  );
}

// Where the end of `text` that is at most `fits` can start: at the earliest
// clean break, else line start, whose rest fits, else the latest character
// whose rest fits. `fits` holds for a shorter end whenever for a longer one,
// so each is found by halving: `fits` measures the whole rest, and asking it
// of every line would take seconds on a long reply.
// A rest of blank lines only isn't an end: a text cut at a clean break ends
// with them, and its last paragraph may be longer than fits.
export function tailStart(text: string, fits: (tail: string) => boolean) {
  if (fits(text)) return 0;
  const { lines: all, starts, open } = lines(text);
  // The last line an end can start at: the last that isn't blank.
  let last = all.length - 1;
  while (last > 0 && blank(all[last])) last--;
  const lineFits = (index: number) => fits(text.slice(starts[index]));
  if (last >= 1 && lineFits(last)) {
    // The earliest line whose rest fits; line 0's is the whole text.
    let low = 0;
    let high = last;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (lineFits(middle)) high = middle;
      else low = middle;
    }
    for (let index = high; index <= last; index++)
      if (open[index] === null && blank(all[index - 1]) && !blank(all[index]))
        return starts[index];
    return starts[high];
  }
  // No line's rest fits, so the end starts within the last one.
  let low = starts[last];
  let high = text.length;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fits(text.slice(middle))) high = middle;
    else low = middle;
  }
  return high;
}

// The fence open at `index` of `text`, by the whole lines before it, or null.
const fenceAt = (text: string, index: number) =>
  lines(text.slice(0, index)).open.at(-1) ?? null;

// `text` split at `cuts`, in order, each part to be drawn as Markdown of its
// own: a part that begins inside a fenced code block opens it again, and one
// that ends inside it closes it.
export function splitAt(text: string, cuts: number[]): string[] {
  const bounds = [0, ...cuts, text.length];
  const fences = bounds.map((at) => (at === 0 ? null : fenceAt(text, at)));
  return bounds.slice(1).map((end, index) => {
    const start = bounds[index];
    let part = text.slice(start, end);
    const opening = fences[index];
    if (opening !== null) part = `${opening}\n${part}`;
    const closing = index < cuts.length ? fences[index + 1] : null;
    if (closing !== null)
      part = `${part}${part.endsWith("\n") ? "" : "\n"}${FENCE.exec(closing)![1]}`;
    return part;
  });
}
