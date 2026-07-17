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
from scripts.remote._lock import UpstreamLock
from scripts.remote._verified_build import (
    BUILD_SCHEMA,
    PACKAGE_SCHEMA,
    component_build_id,
    release_build_id,
)

COMPONENT_BUILD_ID = "89abcdef0123456701234567"
LOCK_DIGEST = "2" * 64
MCP_VERSION = "1.5.0"
MCP_RELATIVE = "mcp/bin/chrome-devtools-mcp.js"
MCP_PAYLOAD = b"export const ready = true;\n"
BUILD_ID = release_build_id(
    COMPONENT_BUILD_ID,
    {MCP_RELATIVE: hashlib.sha256(MCP_PAYLOAD).hexdigest()},
    ("mcp", "mcp/bin"),
)
EXTRA_RELATIVE = "mcp/unlisted.js"
SPECIAL_RELATIVE = "mcp/unsupported"
ESCAPING_RELATIVE = "../outside"
SOURCE_PROVENANCE = {
    "chrome_devtools_mcp": {
        "upstream_commit": "3" * 40,
        "build_commit": "4" * 40,
    }
}


def provenance_for_lock(lock: UpstreamLock) -> dict[str, dict[str, str]]:
    return {
        "chrome_devtools_mcp": {
            "upstream_commit": lock.mcp.upstream_commit,
            "build_commit": lock.mcp.commit,
        }
    }


def create_verified_component_build(
    parent: Path,
    lock: UpstreamLock,
    *,
    extra_directories: tuple[str, ...] = (),
) -> tuple[Path, str, dict[str, str], list[str]]:
    component_id = component_build_id(lock.digest)
    build_root = parent / "remote-build"
    runtime = build_root / "builds" / component_id / "runtime"
    write_file(runtime / MCP_RELATIVE, MCP_PAYLOAD)
    for relative in extra_directories:
        (runtime / relative).mkdir(parents=True)
    files, directories = release_tree(runtime)
    manifest = {
        "schema": BUILD_SCHEMA,
        "build_id": component_id,
        "lock_digest": lock.digest,
        "source_date_epoch": 1,
        "versions": {"chrome_devtools_mcp": lock.mcp.version},
        "provenance": provenance_for_lock(lock),
        "files": files,
        "directories": directories,
    }
    (runtime.parent / "build-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return build_root, component_id, files, directories


def create_release(
    parent: Path,
    *,
    build_id: str = BUILD_ID,
    component_build_id: str = COMPONENT_BUILD_ID,
    lock_digest: str = LOCK_DIGEST,
    provenance: dict[str, dict[str, str]] | None = None,
) -> Path:
    release = parent / f"release-{build_id}"
    write_file(release / MCP_RELATIVE, MCP_PAYLOAD)
    files, directories = release_tree(release)
    manifest_payload = {
        "schema": PACKAGE_SCHEMA,
        "build_id": build_id,
        "component_build_id": component_build_id,
        "lock_digest": lock_digest,
        "versions": {"chrome_devtools_mcp": MCP_VERSION},
        "provenance": provenance or SOURCE_PROVENANCE,
        "files": files,
        "directories": directories,
    }
    write_manifest_and_checksums(release, manifest_payload)
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
    member.linkname = MCP_RELATIVE
    return member


def hard_link_member(release: Path) -> tarfile.TarInfo:
    member = tarfile.TarInfo(f"{release.name}/{SPECIAL_RELATIVE}")
    member.type = tarfile.LNKTYPE
    member.linkname = f"{release.name}/{MCP_RELATIVE}"
    return member


def device_member(release: Path) -> tarfile.TarInfo:
    member = tarfile.TarInfo(f"{release.name}/{SPECIAL_RELATIVE}")
    member.type = tarfile.CHRTYPE
    member.devmajor = 1
    member.devminor = 3
    return member


def add_symbolic_link(release: Path) -> None:
    (release / SPECIAL_RELATIVE).symlink_to(MCP_RELATIVE)


def add_hard_link(release: Path) -> None:
    os.link(release / MCP_RELATIVE, release / SPECIAL_RELATIVE)


def add_fifo(release: Path) -> None:
    os.mkfifo(release / SPECIAL_RELATIVE)


def release_manifest(release: Path) -> ReleaseManifest:
    return read_manifest(release)


def write_file(path: Path, payload: bytes, *, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    path.chmod(0o755 if executable else 0o644)


def rewrite_release_file(release: Path, relative: str, payload: bytes) -> None:
    write_file(release / relative, payload)
    manifest = json.loads((release / "manifest.json").read_text(encoding="utf-8"))
    manifest["files"][relative] = sha256(release / relative)
    write_manifest_and_checksums(release, manifest)


def write_manifest_and_checksums(release: Path, manifest: dict[str, object]) -> None:
    (release / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    files = manifest["files"]
    if not isinstance(files, dict):
        raise AssertionError("manifest files must be a mapping")
    with (release / "SHA256SUMS").open("wb") as stream:
        for relative in sorted([*files, "manifest.json"]):
            stream.write(
                sha256(release / relative).encode("ascii")
                + b"  "
                + relative.encode("utf-8")
                + b"\0"
            )


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
            if not stat.S_ISREG(path.lstat().st_mode):
                raise AssertionError(path)
            files[path.relative_to(root).as_posix()] = sha256(path)
    return dict(sorted(files.items())), sorted(directories)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
