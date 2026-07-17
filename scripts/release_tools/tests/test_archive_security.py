from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path

from scripts.mcp._archive import read_manifest, verify_manifest
from scripts.mcp._identity import PACKAGE_SCHEMA, release_build_id
from scripts.release_tools.archive import single_release_root, unpack_archive
from scripts.release_tools.common import WorkflowError

MCP_RELATIVE = "mcp/bin/chrome-devtools-mcp.js"
MCP_PAYLOAD = b"export const ready = true;\n"
COMPONENT_ID = "1" * 24
LOCK_DIGEST = "2" * 64
MCP_VERSION = "1.5.0"
UNLISTED_RELATIVE = "mcp/unlisted.js"
UNSUPPORTED_RELATIVE = "mcp/unsupported"
PROVENANCE = {
    "chrome_devtools_mcp": {
        "upstream_commit": "3" * 40,
        "build_commit": "4" * 40,
    }
}


class ArchiveSecurityTest(unittest.TestCase):
    def test_manifest_rejects_unlisted_regular_file(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            release = unpack_valid_release(root)
            (release / UNLISTED_RELATIVE).write_bytes(b"not in manifest\n")

            with self.assertRaises(WorkflowError):
                verify_manifest(release, read_manifest(release))

    def test_unpack_rejects_links_and_device_entries(self) -> None:
        factories = (symbolic_link_member, hard_link_member, device_member)
        for factory in factories:
            with (
                self.subTest(entry_type=factory.__name__),
                tempfile.TemporaryDirectory(dir="/tmp") as name,
            ):
                root = Path(name)
                source = create_release(root)
                archive = create_archive(root, source, extra=factory(source))
                staging = root / "staging"
                staging.mkdir()

                with self.assertRaises(WorkflowError):
                    unpack_archive(archive, staging)

    def test_unpack_rejects_parent_path_escape(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            source = create_release(root)
            escaping = tarfile.TarInfo("../outside")
            archive = create_archive(root, source, extra=escaping)
            staging = root / "staging"
            staging.mkdir()

            with self.assertRaises(WorkflowError):
                unpack_archive(archive, staging)

            self.assertFalse((root / "outside").exists())

    def test_manifest_rejects_unsafe_post_unpack_tree(self) -> None:
        mutations: tuple[Callable[[Path], None], ...] = (
            add_symbolic_link,
            add_hard_link,
            add_fifo,
        )
        for mutate in mutations:
            with (
                self.subTest(entry_type=mutate.__name__),
                tempfile.TemporaryDirectory(dir="/tmp") as name,
            ):
                release = unpack_valid_release(Path(name))
                mutate(release)

                with self.assertRaises(WorkflowError):
                    verify_manifest(release, read_manifest(release))


def unpack_valid_release(root: Path) -> Path:
    source = create_release(root)
    archive = create_archive(root, source)
    staging = root / "staging"
    staging.mkdir()
    unpack_archive(archive, staging)
    return single_release_root(staging)


def create_release(root: Path) -> Path:
    release = root / "release"
    executable = release / MCP_RELATIVE
    executable.parent.mkdir(parents=True)
    executable.write_bytes(MCP_PAYLOAD)
    files = {MCP_RELATIVE: file_sha256(executable)}
    directories = ["mcp", "mcp/bin"]
    manifest = {
        "schema": PACKAGE_SCHEMA,
        "build_id": release_build_id(COMPONENT_ID, files, directories),
        "component_build_id": COMPONENT_ID,
        "lock_digest": LOCK_DIGEST,
        "versions": {"chrome_devtools_mcp": MCP_VERSION},
        "provenance": PROVENANCE,
        "files": files,
        "directories": directories,
    }
    (release / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    write_checksums(release, files)
    return release


def write_checksums(release: Path, files: dict[str, str]) -> None:
    records = []
    for relative in sorted([*files, "manifest.json"]):
        records.append(
            file_sha256(release / relative).encode("ascii")
            + b"  "
            + relative.encode("utf-8")
            + b"\0"
        )
    (release / "SHA256SUMS").write_bytes(b"".join(records))


def create_archive(
    root: Path, release: Path, *, extra: tarfile.TarInfo | None = None
) -> Path:
    tar_path = root / "release.tar"
    archive = root / "release.tar.zst"
    with tarfile.open(tar_path, "w", format=tarfile.GNU_FORMAT) as stream:
        stream.add(release, arcname=release.name, recursive=True)
        if extra is not None:
            if extra.isreg():
                payload = b"unexpected\n"
                extra.size = len(payload)
                stream.addfile(extra, io.BytesIO(payload))
            else:
                stream.addfile(extra)
    subprocess.run(
        ("zstd", "--quiet", "--force", str(tar_path), "-o", str(archive)),
        check=True,
    )
    return archive


def symbolic_link_member(release: Path) -> tarfile.TarInfo:
    member = tarfile.TarInfo(f"{release.name}/{UNSUPPORTED_RELATIVE}")
    member.type = tarfile.SYMTYPE
    member.linkname = MCP_RELATIVE
    return member


def hard_link_member(release: Path) -> tarfile.TarInfo:
    member = tarfile.TarInfo(f"{release.name}/{UNSUPPORTED_RELATIVE}")
    member.type = tarfile.LNKTYPE
    member.linkname = f"{release.name}/{MCP_RELATIVE}"
    return member


def device_member(release: Path) -> tarfile.TarInfo:
    member = tarfile.TarInfo(f"{release.name}/{UNSUPPORTED_RELATIVE}")
    member.type = tarfile.CHRTYPE
    member.devmajor = 1
    member.devminor = 3
    return member


def add_symbolic_link(release: Path) -> None:
    (release / UNSUPPORTED_RELATIVE).symlink_to(MCP_RELATIVE)


def add_hard_link(release: Path) -> None:
    os.link(release / MCP_RELATIVE, release / UNSUPPORTED_RELATIVE)


def add_fifo(release: Path) -> None:
    os.mkfifo(release / UNSUPPORTED_RELATIVE)


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    unittest.main()
