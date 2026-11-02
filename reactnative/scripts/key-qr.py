# /// script
# requires-python = ">=3.11"
# dependencies = ["qrcode>=8.2,<9", "python-dotenv>=1.1,<2"]
# ///
"""Display the project's OpenRouter key as a local QR. Never print the key."""
from __future__ import annotations

import io
import json
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import threading
import webbrowser

from dotenv import dotenv_values
import qrcode
from qrcode.image.svg import SvgPathImage


def read_key(path: Path) -> str:
    value = dotenv_values(path).get("OPENROUTER_API_KEY")
    if not value or not re.fullmatch(r"sk-or-[A-Za-z0-9_-]{16,2048}", value.strip()):
        raise ValueError("OPENROUTER_API_KEY is missing or invalid in the project's .env.")
    return value.strip()


def qr_page(key: str) -> bytes:
    payload = json.dumps({"type": "agyspeak.openrouter-key", "version": 1, "key": key}, separators=(",", ":"))
    output = io.BytesIO()
    qrcode.make(payload, image_factory=SvgPathImage, border=4).save(output)
    svg = output.getvalue().decode().split("?>", 1)[-1]
    return f'''<!doctype html><meta charset="utf-8"><title>AGSpeak key QR</title>
<meta name="referrer" content="no-referrer">
<style>body{{font:18px system-ui;background:#faf9f6;color:#20211f;text-align:center;margin:48px auto;max-width:640px}}svg{{width:min(80vw,420px);height:auto;background:white}}p{{line-height:1.5}}button{{font:inherit;padding:12px}}</style>
<h1>Connect AGSpeak</h1><p>On your phone: Settings → Scan QR → Save.</p>
<div id="qr">{svg}</div><p>This QR contains your API key. Keep it private.</p>
<button onclick="document.getElementById('qr').replaceChildren()">Hide QR</button>
<script>setTimeout(()=>document.getElementById('qr').replaceChildren(),300000)</script>'''.encode()


def main() -> None:
    env_path = Path(__file__).resolve().parents[2] / ".env"
    try:
        page = qr_page(read_key(env_path))
    except ValueError as error:
        raise SystemExit(str(error)) from None

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            if self.path != "/":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
            self.end_headers()
            self.wfile.write(page)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    url = f"http://127.0.0.1:{server.server_port}/"
    # No secret is written to disk, sent over the LAN, or included in this URL.
    webbrowser.open(url)
    print(f"Key QR opened locally at {url}")
    print("Scan it in AGSpeak Settings. Press Ctrl+C when finished (expires in 5 minutes).")
    timer = threading.Timer(300, server.shutdown)
    timer.daemon = True
    timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        timer.cancel()
        server.server_close()


if __name__ == "__main__":
    main()
