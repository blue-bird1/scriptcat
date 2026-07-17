from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

from scripts.remote.provider._lock import ProviderLock

def create_provider_archive(
    root: Path,
    lock: ProviderLock,
    *,
    build_id: str,
    component_id: str,
) -> Path:
    release = root / f"release-{build_id}"
    chrome = release / "chrome-linux" / "chrome"
    chrome.parent.mkdir(parents=True)
    chrome.write_text(
        f"#!/bin/sh\necho 'Chromium {lock.chromium.version}'\n", encoding="utf-8"
    )
    chrome.chmod(0o755)
    files = {"chrome-linux/chrome": _sha256(chrome)}
    manifest = {
        "schema": 2,
        "build_id": build_id,
        "component_build_id": component_id,
        "lock_digest": lock.digest,
        "versions": {
            "chromium": lock.chromium.version,
            "depot_tools": lock.depot_tools.version,
        },
        "provenance": {
            "chromium": {
                "upstream_commit": lock.chromium.commit,
                "patch_digest": lock.chromium_patch.sha256,
            },
            "depot_tools": {"upstream_commit": lock.depot_tools.commit},
        },
        "files": files,
        "directories": ["chrome-linux"],
    }
    manifest_path = release / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    checksums = release / "SHA256SUMS"
    with checksums.open("wb") as stream:
        for relative in ("chrome-linux/chrome", "manifest.json"):
            stream.write(
                _sha256(release / relative).encode("ascii")
                + b"  "
                + relative.encode("utf-8")
                + b"\0"
            )
    archive = root / f"{release.name}.tar.zst"
    tar = subprocess.Popen(
        ("tar", "-C", str(root), "-cf", "-", release.name), stdout=subprocess.PIPE
    )
    assert tar.stdout is not None
    try:
        subprocess.run(
            ("zstd", "-q", "-o", str(archive)),
            stdin=tar.stdout,
            check=True,
        )
    finally:
        tar.stdout.close()
    if tar.wait() != 0:
        raise RuntimeError("unable to create provider archive")
    return archive


def archive_sha256(path: Path) -> str:
    return _sha256(path)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
