# /// script
# requires-python = ">=3.13"
# dependencies = ["numpy", "sounddevice", "soundfile"]
# ///
"""Minimal microphone recorder. Run with:

uv run --python ~/.local/bin/python3 scripts/recorder_gui.py

Requires a Python installation with Tkinter (the project's Python lacks Tk).
Recordings stay local in ~/Music/AGSpeak Recordings.
"""

import argparse
from datetime import datetime
from pathlib import Path
import subprocess
import time
import tkinter as tk
from tkinter import messagebox

import numpy as np
import sounddevice as sd
import soundfile as sf


PROMPTS = [
    ("th-normal", "TH: normal", "Say ‘brother’ normally, with your best voiced TH. Tongue lightly between your teeth; keep air and voice flowing.",
     "My brother bought a bottle of water."),
    ("th-d", "TH: deliberately use D", "Use a D instead of TH in ‘brother’: ‘brudder’. Keep everything else as similar as possible.",
     "My brother bought a bottle of water."),
    ("th-z", "TH: deliberately use Z", "Use a Z instead of TH in ‘brother’: ‘bruzzer’. Keep everything else as similar as possible.",
     "My brother bought a bottle of water."),
    ("garden-first", "Word stress: GAR-den", "Stress the FIRST syllable of garden: GAR-den. Say the rest normally.",
     "I parked the car near the garden."),
    ("garden-second", "Word stress: gar-DEN", "Deliberately stress the SECOND syllable of garden: gar-DEN. Say the rest normally.",
     "I parked the car near the garden."),
    ("emphasis-i", "Sentence emphasis: I", "Emphasize I, as if correcting who parked the car: ‘I parked it, not someone else.’ Read only the sentence below.",
     "I parked the car near the garden."),
    ("emphasis-car", "Sentence emphasis: CAR", "Emphasize CAR, as if correcting what you parked: ‘the car, not the bicycle.’ Read only the sentence below.",
     "I parked the car near the garden."),
    ("rhythm-smooth", "Rhythm: smooth", "Read smoothly and naturally, linking words. No deliberate pauses between words.",
     "My brother bought a better bottle of tomato sauce."),
    ("rhythm-pauses", "Rhythm: deliberate pauses", "Use the same delivery, but pause clearly after ‘brother’ and after ‘bottle’. Keep the other words connected.",
     "My brother bought a better bottle of tomato sauce."),
    ("natural-1", "Natural reading 1", "Use your best natural English. Do not deliberately introduce errors or imitate an accent.",
     "I left my keys on the kitchen table before going to work."),
    ("natural-2", "Natural reading 2", "Use your best natural English. Do not deliberately introduce errors or imitate an accent.",
     "Could you bring me a glass of water and close the window?"),
    ("natural-3", "Natural reading 3", "Use your best natural English. Do not deliberately introduce errors or imitate an accent.",
     "We were planning to meet on Thursday, but the train was late."),
]

SWEDISH_PROMPTS = [
    ("swedish-incorrect", "Swedish: deliberately incorrect",
     "Say your chosen phrase with the pronunciation you know is incorrect. Read only the phrase, without explaining the mistake.",
     "Your Swedish phrase — same for both takes."),
    ("swedish-correct", "Swedish: your best pronunciation",
     "Say the SAME phrase with the pronunciation you think is correct. Read only the phrase, without explaining what changed.",
     "Your Swedish phrase — same for both takes."),
]


class Recorder:
    def __init__(self, root, prompts=None):
        self.root = root
        self.prompts = PROMPTS if prompts is None else prompts
        self.stream = None
        self.frames = []
        self.path = None
        self.playing = False
        self.started = 0
        self.prompt_index = 0
        root.title("AGSpeak recorder")
        root.geometry("700x490")
        nav = tk.Frame(root)
        nav.pack(pady=12)
        self.previous_button = tk.Button(nav, text="← Previous", command=lambda: self.move(-1))
        self.previous_button.pack(side="left", padx=10)
        self.progress = tk.StringVar()
        tk.Label(nav, textvariable=self.progress, width=34).pack(side="left")
        self.next_button = tk.Button(nav, text="Next →", command=lambda: self.move(1))
        self.next_button.pack(side="left", padx=10)
        self.title = tk.StringVar()
        tk.Label(root, textvariable=self.title, font=("Helvetica", 16, "bold")).pack(pady=5)
        self.instruction = tk.StringVar()
        tk.Label(root, textvariable=self.instruction, wraplength=650).pack(pady=8)
        self.sentence = tk.StringVar()
        tk.Label(root, textvariable=self.sentence, font=("Helvetica", 20),
                 wraplength=650).pack(pady=12)
        self.shared_phrase = tk.StringVar()
        if self.prompts is SWEDISH_PROMPTS:
            root.title("AGSpeak recorder — Swedish A/B")
            root.geometry("700x550")
            tk.Label(root, text="Optional: type your phrase here to display it for both takes").pack()
            self.phrase_entry = tk.Entry(root, textvariable=self.shared_phrase, width=65)
            self.phrase_entry.pack(pady=5)
            self.shared_phrase.trace_add("write", self.update_phrase)
        tk.Label(root, text="Read only the large sentence. Start → speak → Stop → play to check → Next.",
                 wraplength=650).pack()
        self.status = tk.StringVar(value="Ready. Press Start, then speak. No time limit.")
        tk.Label(root, textvariable=self.status, wraplength=520).pack(pady=15)
        self.record_button = tk.Button(root, text="Start recording", command=self.toggle,
                                       width=24, height=2)
        self.record_button.pack(pady=5)
        row = tk.Frame(root)
        row.pack(pady=10)
        self.play_button = tk.Button(row, text="Play last recording", command=self.play,
                                     state="disabled")
        self.play_button.pack(side="left", padx=5)
        tk.Button(row, text="Open recordings folder", command=self.open_folder).pack(side="left", padx=5)
        self.filename = tk.StringVar(value="")
        tk.Label(root, textvariable=self.filename, wraplength=520).pack()
        self.show_prompt()
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.after(100, self.tick)

    @staticmethod
    def directory():
        path = Path.home() / "Music" / "AGSpeak Recordings"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def show_prompt(self):
        slug, title, instruction, sentence = self.prompts[self.prompt_index]
        takes = sorted(self.directory().glob(f"eval-{slug}-*.wav"))
        self.path = takes[-1] if takes else None
        self.progress.set(f"Prompt {self.prompt_index + 1} / {len(self.prompts)} · {len(takes)} saved take(s)")
        self.title.set(title)
        self.instruction.set(instruction)
        self.sentence.set(self.shared_phrase.get().strip() or sentence)
        self.filename.set(str(self.path) if self.path else "")
        self.play_button.config(state="normal" if self.path else "disabled", text="Play last recording")
        self.previous_button.config(state="normal" if self.prompt_index else "disabled")
        self.next_button.config(state="normal" if self.prompt_index < len(self.prompts) - 1 else "disabled")
        self.status.set("Saved take available. Play or record again." if self.path else "Ready. Press Start, then speak. No time limit.")

    def update_phrase(self, *_):
        self.sentence.set(self.shared_phrase.get().strip() or self.prompts[self.prompt_index][3])

    def move(self, direction):
        if self.stream is not None:
            return
        sd.stop()
        self.playing = False
        self.prompt_index = max(0, min(len(self.prompts) - 1, self.prompt_index + direction))
        self.show_prompt()

    def toggle(self):
        if self.stream is not None:
            self.stop()
            return
        try:
            sd.stop()
            self.playing = False
            self.frames = []
            self.rate = int(sd.query_devices(kind="input")["default_samplerate"])
            stream = sd.InputStream(samplerate=self.rate, channels=1, dtype="int16",
                                    callback=self.capture)
            stream.start()
            self.stream = stream
            self.started = time.monotonic()
            self.record_button.config(text="Stop and save")
            self.play_button.config(state="disabled", text="Play last recording")
            self.previous_button.config(state="disabled")
            self.next_button.config(state="disabled")
            self.status.set("● RECORDING — press Stop when you finish")
        except Exception as exc:
            messagebox.showerror("Could not start microphone", str(exc))

    def capture(self, data, frames, timing, status):
        self.frames.append(data.copy())

    def stop(self):
        stream, self.stream = self.stream, None
        stream.stop()
        stream.close()
        self.record_button.config(text="Start recording")
        if not self.frames:
            self.status.set("No audio captured. Try again.")
            return
        try:
            audio = np.concatenate(self.frames)
            self.frames = []
            slug = self.prompts[self.prompt_index][0]
            path = self.directory() / f"eval-{slug}-{datetime.now():%Y%m%d-%H%M%S-%f}.wav"
            sf.write(path, audio, self.rate, subtype="PCM_16")
            self.path = path
            self.show_prompt()
            self.status.set(f"Saved {len(audio) / self.rate:.1f} seconds. Play it to check.")
            self.play_button.config(state="normal")
        except Exception as exc:
            messagebox.showerror("Could not save recording", str(exc))

    def play(self):
        if self.playing:
            sd.stop()
            self.playing = False
            self.play_button.config(text="Play last recording")
            return
        try:
            audio, rate = sf.read(self.path, dtype="float32")
            sd.play(audio, rate)
            self.playing = True
            self.play_button.config(text="Stop playback")
        except Exception as exc:
            messagebox.showerror("Could not play recording", str(exc))

    def open_folder(self):
        subprocess.Popen(["open", str(self.directory())])

    def tick(self):
        if self.stream is not None:
            self.status.set(f"● RECORDING — {time.monotonic() - self.started:.1f}s — press Stop when finished")
        elif self.playing and not sd.get_stream().active:
            self.playing = False
            self.play_button.config(text="Play last recording")
        self.root.after(100, self.tick)

    def close(self):
        if self.stream is not None:
            self.stop()
        sd.stop()
        self.root.destroy()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--swedish", action="store_true", help="Two Swedish pronunciation comparison takes")
    args = parser.parse_args()
    root = tk.Tk()
    Recorder(root, SWEDISH_PROMPTS if args.swedish else None)
    root.mainloop()
