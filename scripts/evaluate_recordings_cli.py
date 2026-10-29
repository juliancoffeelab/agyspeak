"""Compare CLI Medium with the saved API eval: .venv/bin/python scripts/evaluate_recordings_cli.py PATH"""

import argparse
import ast
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import shutil
import tempfile

from agyspeak.backend import AgyClient


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, help="JSON report from evaluate_recordings.py; results are appended")
    report_path = parser.parse_args().report
    report = json.loads(report_path.read_text())
    source = ast.parse(Path(__file__).with_name("evaluate_recordings.py").read_text())
    tasks = next(ast.literal_eval(node.value) for node in source.body
                 if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "TASKS" for t in node.targets))
    jobs = [(case, 1) for case in report["selected"]]
    jobs += [(case, repeat) for case in report["selected"] if case["slug"] in {"th-normal", "garden-first"}
             for repeat in (2, 3)]
    # Native file tools expose filenames to the model. Hide intended labels.
    anonymous = Path(tempfile.mkdtemp(prefix="agyspeak-listening-"))
    audio_paths = {}
    for number, case in enumerate(report["selected"], 1):
        path = anonymous / f"clip-{number:02d}.wav"
        shutil.copyfile(case["path"], path)
        audio_paths[case["slug"]] = path

    def run(case, repeat):
        prompt = ("Listen to the audio. Transcribe exactly what is spoken, preserving mistakes and false starts; "
                  "use [unclear] for unintelligible words. " + tasks[case["task"]] +
                  " Give brief acoustic evidence for the observation; do not invent details. "
                  "If the target word is absent or unintelligible, answer unclear. "
                  "Return only a JSON object with three string fields: transcript, observation, evidence.")
        result = dict(slug=case["slug"], model="gemini-3.8-flash-medium", route="Antigravity CLI", repeat=repeat)
        client = AgyClient(preamble=None, turn_timeout=90)
        try:
            turn = client.send(prompt, audio=audio_paths[case["slug"]])
            text = turn.response.strip()
            if text.startswith("```"):
                text = "\n".join(text.splitlines()[1:-1])
            result.update(answer=json.loads(text), total_seconds=turn.duration,
                          status=turn.status, log=str(turn.log_path))
        except Exception as exc:
            result["error"] = type(exc).__name__
        return result

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run, case, repeat) for case, repeat in jobs]
        for number, future in enumerate(as_completed(futures), 1):
            result = future.result()
            report["results"].append(result)
            report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
            print(f"{number}/{len(jobs)} {result['slug']} r{result['repeat']}: "
                  f"{result.get('answer', {}).get('observation', result.get('error'))}", flush=True)
    print(f"Results: {report_path}", flush=True)


if __name__ == "__main__":
    main()
