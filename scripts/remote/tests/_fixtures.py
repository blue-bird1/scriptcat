from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import subprocess
import tarfile
from pathlib import Path

from scripts.remote._archive import ReleaseManifest, read_manifest

BUILD_ID = "0123456789abcdef01234567"
CHROMIUM_VERSION = "148.0.7778.215"
MCP_VERSION = "1.5.0"
DEPOT_TOOLS_VERSION = "chromium-148-deps"
SCRIPTCAT_VERSION = "1.3.2"
CHROME_RELATIVE = "chromium/chrome-linux/chrome"
MCP_RELATIVE = "mcp/bin/chrome-devtools-mcp.js"
EXTENSION_MANIFEST_RELATIVE = "scriptcat/manifest.json"
EXTENSION_WORKER_RELATIVE = "scriptcat/worker.js"
EXTRA_RELATIVE = "scriptcat/unlisted.js"
SPECIAL_RELATIVE = "scriptcat/unsupported"
ESCAPING_RELATIVE = "../outside"


def create_release(parent: Path, *, build_id: str = BUILD_ID) -> Path:
    release = parent / f"release-{build_id}"
    write_file(
        release / CHROME_RELATIVE,
        f"#!/bin/sh\nprintf '%s\\n' 'Chromium {CHROMIUM_VERSION}'\n".encode(),
        executable=True,
    )
    write_file(release / MCP_RELATIVE, b"export const ready = true;\n")
    write_file(release / EXTENSION_MANIFEST_RELATIVE, b'{"manifest_version":3}\n')
    write_file(release / EXTENSION_WORKER_RELATIVE, b"const managed = true;\n")
    files, directories = release_tree(release)
    manifest_payload = {
        "build_id": build_id,
        "chromium_version": CHROMIUM_VERSION,
        "mcp_version": MCP_VERSION,
        "depot_tools_version": DEPOT_TOOLS_VERSION,
        "scriptcat_version": SCRIPTCAT_VERSION,
        "files": files,
        "directories": directories,
    }
    manifest_path = release / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest_payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    checksums = release / "SHA256SUMS"
    with checksums.open("wb") as stream:
        for relative in sorted([*files, "manifest.json"]):
            stream.write(
                sha256(release / relative).encode("ascii")
                + b"  "
                + relative.encode("utf-8")
                + b"\0"
            )
    return release


def create_archive(
    parent: Path,
    release: Path,
    *,
    extra: tarfile.TarInfo | None = None,
    payload: bytes = b"unexpected\n",
) -> Path:
    tar_path = parent / "release.tar"
    archive_path = parent / "release.tar.zst"
    with tarfile.open(tar_path, "w", format=tarfile.GNU_FORMAT) as stream:
        stream.add(release, arcname=release.name, recursive=True)
        if extra is not None:
            if extra.type in {tarfile.REGTYPE, tarfile.AREGTYPE}:
                extra.size = len(payload)
                stream.addfile(extra, io.BytesIO(payload))
            else:
                stream.addfile(extra)
    subprocess.run(
        ("zstd", "--quiet", "--force", str(tar_path), "-o", str(archive_path)),
        check=True,
    )
    return archive_path


def regular_member(release: Path, relative: str) -> tarfile.TarInfo:
    return tarfile.TarInfo(f"{release.name}/{relative}")


def symbolic_link_member(release: Path) -> tarfile.TarInfo:
    member = tarfile.TarInfo(f"{release.name}/{SPECIAL_RELATIVE}")
    member.type = tarfile.SYMTYPE
    member.linkname = EXTENSION_MANIFEST_RELATIVE
    return member


def hard_link_member(release: Path) -> tarfile.TarInfo:
    member = tarfile.TarInfo(f"{release.name}/{SPECIAL_RELATIVE}")
    member.type = tarfile.LNKTYPE
    member.linkname = f"{release.name}/{EXTENSION_MANIFEST_RELATIVE}"
    return member


def device_member(release: Path) -> tarfile.TarInfo:
    member = tarfile.TarInfo(f"{release.name}/{SPECIAL_RELATIVE}")
    member.type = tarfile.CHRTYPE
    member.devmajor = 1
    member.devminor = 3
    return member


def add_symbolic_link(release: Path) -> None:
    (release / SPECIAL_RELATIVE).symlink_to(EXTENSION_MANIFEST_RELATIVE)


def add_hard_link(release: Path) -> None:
    os.link(
        release / EXTENSION_MANIFEST_RELATIVE,
        release / SPECIAL_RELATIVE,
    )


def add_fifo(release: Path) -> None:
    os.mkfifo(release / SPECIAL_RELATIVE)


def release_manifest(release: Path) -> ReleaseManifest:
    return read_manifest(release)


def write_file(path: Path, payload: bytes, *, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    path.chmod(0o755 if executable else 0o644)


def release_tree(root: Path) -> tuple[dict[str, str], list[str]]:
    files: dict[str, str] = {}
    directories: list[str] = []
    for current, directory_names, file_names in os.walk(root):
        directory_names.sort()
        file_names.sort()
        current_path = Path(current)
        directories.extend(
            (current_path / name).relative_to(root).as_posix()
            for name in directory_names
        )
        for name in file_names:
            path = current_path / name
            status = path.lstat()
            if not stat.S_ISREG(status.st_mode):
                raise AssertionError(path)
            files[path.relative_to(root).as_posix()] = sha256(path)
    return dict(sorted(files.items())), sorted(directories)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()
