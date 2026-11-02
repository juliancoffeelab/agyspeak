"""Install Google's official ACP runtime: python -m agyspeak.acp_runtime.

Downloads software only; does not authenticate or request model inference.
"""

from __future__ import annotations

import hashlib
import platform
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

VERSION = "1.4.5"
RUNTIME_DIR = Path.home() / ".local" / "share" / "agyspeak" / "antigravity-acp" / VERSION
RUNTIME_BINARY = RUNTIME_DIR / "agy_acp_server.par"
# Pinned from agentclientprotocol/registry/antigravity-acp/agent.json.
RELEASES = {
    ("Darwin", "arm64"): ("macos", "darwin-arm64", "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f"),
    ("Darwin", "x86_64"): ("macos", "darwin-x86_64", "b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a"),
    ("Linux", "x86_64"): ("linux", "linux-x86_64", "923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b"),
    ("Linux", "aarch64"): ("linux", "linux-arm64", "7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056"),
}


def install(archive: Path | None = None) -> Path:
    release = RELEASES.get((platform.system(), platform.machine()))
    if release is None:
        raise RuntimeError("Unsupported platform; install antigravity-acp from the ACP Registry")
    directory, target, checksum = release
    with tempfile.TemporaryDirectory(prefix="agyspeak-acp-") as temporary:
        staging = Path(temporary)
        if archive is None:
            archive = staging / "runtime.zip"
            url = f"https://dl.google.com/agy-extensions/releases/{directory}/agy-acp-server-{VERSION}-{target}.zip"
            print(f"Downloading Antigravity ACP {VERSION} from Google…", flush=True)
            with urllib.request.urlopen(url, timeout=120) as source, archive.open("wb") as output:
                shutil.copyfileobj(source, output)
        with archive.open("rb") as source:
            actual_checksum = hashlib.file_digest(source, "sha256").hexdigest()
        if actual_checksum != checksum:
            raise RuntimeError("Antigravity ACP archive checksum does not match the registry")
        with zipfile.ZipFile(archive) as bundle:
            # Preserve the required sibling executable; never extract arbitrary paths.
            for name in ("agy_acp_server.par", "localharness_external"):
                with bundle.open(name) as source, (staging / name).open("wb") as output:
                    shutil.copyfileobj(source, output)
                (staging / name).chmod(0o755)
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        for name in ("agy_acp_server.par", "localharness_external"):
            shutil.copy2(staging / name, RUNTIME_DIR / name)
    return RUNTIME_BINARY


if __name__ == "__main__":
    print(install())
