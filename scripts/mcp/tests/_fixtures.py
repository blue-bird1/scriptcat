from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import tarfile
from dataclasses import dataclass
from pathlib import Path

from scripts.mcp._archive import ReleaseManifest, read_manifest
from scripts.mcp._identity import PACKAGE_SCHEMA, component_build_id, release_build_id
from scripts.mcp._lock import load_lock

MCP_RELATIVE = "mcp/bin/chrome-devtools-mcp.js"
MCP_PAYLOAD = b"export const ready = true;\n"
MCP_VERSION = "1.5.0"
SOURCE = "https://github.com/blue-bird1/chrome-devtools-mcp.git"
UPSTREAM_SOURCE = "https://github.com/ChromeDevTools/chrome-devtools-mcp.git"
UPSTREAM_COMMIT = "1" * 40
BUILD_COMMIT = "2" * 40


@dataclass(frozen=True)
class ReleaseFixture:
    lock: Path
    lock_digest: str
    component_id: str
    release: Path
    manifest: ReleaseManifest
    archive: Path
    archive_digest: str


def create_release_fixture(
    root: Path, *, payload: bytes = MCP_PAYLOAD
) -> ReleaseFixture:
    root.mkdir(parents=True)
    lock_path = root / "mcp.lock.json"
    write_lock(lock_path)
    lock = load_lock(lock_path)
    component_id = component_build_id(lock.digest)
    release = root / "release-source"
    executable = release / MCP_RELATIVE
    executable.parent.mkdir(parents=True)
    executable.write_bytes(payload)
    files = {MCP_RELATIVE: file_sha256(executable)}
    directories = ("mcp", "mcp/bin")
    manifest_payload = {
        "schema": PACKAGE_SCHEMA,
        "build_id": release_build_id(component_id, files, directories),
        "component_build_id": component_id,
        "lock_digest": lock.digest,
        "versions": {"chrome_devtools_mcp": MCP_VERSION},
        "provenance": {
            "chrome_devtools_mcp": {
                "upstream_commit": UPSTREAM_COMMIT,
                "build_commit": BUILD_COMMIT,
            }
        },
        "files": files,
        "directories": list(directories),
    }
    write_manifest_and_checksums(release, manifest_payload)
    archive = create_archive(root / "release.tar.zst", release)
    return ReleaseFixture(
        lock=lock_path,
        lock_digest=lock.digest,
        component_id=component_id,
        release=release,
        manifest=read_manifest(release),
        archive=archive,
        archive_digest=file_sha256(archive),
    )


def create_archive(
    archive: Path,
    release: Path,
    *,
    extra_name: str | None = None,
    extra_payload: bytes = b"unexpected\n",
) -> Path:
    tar_path = archive.with_suffix("")
    with tarfile.open(tar_path, "w", format=tarfile.GNU_FORMAT) as stream:
        stream.add(release, arcname=release.name, recursive=True)
        if extra_name is not None:
            member = tarfile.TarInfo(f"{release.name}/{extra_name}")
            member.size = len(extra_payload)
            stream.addfile(member, io.BytesIO(extra_payload))
    subprocess.run(
        ("zstd", "--quiet", "--force", str(tar_path), "-o", str(archive)),
        check=True,
    )
    return archive


def clone_release(source: Path, destination: Path) -> Path:
    import shutil

    return Path(shutil.copytree(source, destination))


def write_manifest_and_checksums(
    release: Path, manifest_payload: dict[str, object]
) -> None:
    (release / "manifest.json").write_text(
        json.dumps(manifest_payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    files = manifest_payload["files"]
    if not isinstance(files, dict):
        raise AssertionError("manifest files must be a mapping")
    records = []
    for relative in sorted([*files, "manifest.json"]):
        records.append(
            file_sha256(release / relative).encode("ascii")
            + b"  "
            + relative.encode("utf-8")
            + b"\0"
        )
    (release / "SHA256SUMS").write_bytes(b"".join(records))


def write_lock(path: Path) -> None:
    payload = {
        "schema_version": 2,
        "chrome_devtools_mcp": {
            "version": MCP_VERSION,
            "commit": BUILD_COMMIT,
            "source": SOURCE,
            "upstream_source": UPSTREAM_SOURCE,
            "upstream_commit": UPSTREAM_COMMIT,
        },
    }
    path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")


def link_targets(data_root: Path) -> tuple[str | None, str | None]:
    return link_target(data_root / "current"), link_target(data_root / "previous")


def link_target(path: Path) -> str | None:
    return os.readlink(path) if path.is_symlink() else None


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
