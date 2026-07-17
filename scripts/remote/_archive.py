from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tarfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from ._archive_digest import (
    ARCHIVE_DIGEST_SUFFIX,
    archive_digest_path,
    copy_verified_archive,
    is_sha256,
    read_archive_digest,
    sha256,
    validate_sha256_digest,
)
from ._common import WorkflowError
from ._verified_build import PACKAGE_SCHEMA

__all__ = (
    "ARCHIVE_DIGEST_SUFFIX",
    "archive_digest_path",
    "copy_verified_archive",
    "read_archive_digest",
    "sha256",
    "validate_sha256_digest",
)

MANIFEST_NAME = "manifest.json"
CHECKSUMS_NAME = "SHA256SUMS"
RESERVED_FILES = frozenset({MANIFEST_NAME, CHECKSUMS_NAME})


@dataclass(frozen=True)
class ReleaseManifest:
    build_id: str
    component_build_id: str
    lock_digest: str
    versions: dict[str, str]
    provenance: dict[str, dict[str, str]]
    files: dict[str, str]
    directories: tuple[str, ...]

    @property
    def mcp_version(self) -> str:
        return self.versions["chrome_devtools_mcp"]

    @property
    def scriptcat_version(self) -> str:
        return self.versions["scriptcat"]


def unpack_archive(archive: Path, staging: Path) -> None:
    if not archive.is_file():
        raise WorkflowError(f"release archive is missing: {archive}")
    try:
        process = subprocess.Popen(
            ("zstd", "--decompress", "--stdout", "--", str(archive)),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        raise WorkflowError(f"cannot start archive decompressor: {error}") from error
    assert process.stdout is not None
    assert process.stderr is not None
    directory_modes: list[tuple[Path, int]] = []
    members: set[str] = set()
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as stream:
            for member in stream:
                relative = archive_member_path(member)
                canonical = relative.as_posix()
                if canonical in members:
                    raise WorkflowError(
                        f"release archive contains a duplicate path: {canonical}"
                    )
                members.add(canonical)
                destination = staging.joinpath(*relative.parts)
                if member.type == tarfile.DIRTYPE:
                    destination.mkdir(parents=True, exist_ok=True)
                    if not destination.is_dir() or destination.is_symlink():
                        raise WorkflowError(
                            "release archive path conflicts with a directory: "
                            f"{canonical}"
                        )
                    directory_modes.append((destination, member.mode & 0o777))
                elif member.type in {tarfile.REGTYPE, tarfile.AREGTYPE}:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    extracted = stream.extractfile(member)
                    if extracted is None:
                        raise WorkflowError(
                            f"release archive file cannot be read: {canonical}"
                        )
                    try:
                        with destination.open("xb") as output:
                            shutil.copyfileobj(extracted, output)
                    except FileExistsError as error:
                        raise WorkflowError(
                            f"release archive path conflicts with a file: {canonical}"
                        ) from error
                    finally:
                        extracted.close()
                    destination.chmod(member.mode & 0o777)
                else:
                    raise WorkflowError(
                        f"release archive contains an unsupported entry: {canonical}"
                    )
        for directory, mode in sorted(
            directory_modes, key=lambda item: len(item[0].parts), reverse=True
        ):
            directory.chmod(mode)
    except (OSError, tarfile.TarError, WorkflowError) as error:
        if process.poll() is None:
            process.kill()
        process.communicate()
        if isinstance(error, WorkflowError):
            raise
        raise WorkflowError(f"cannot unpack release archive: {error}") from error
    else:
        stderr = process.stderr.read().decode("utf-8", errors="replace").strip()
        status = process.wait()
        if status != 0:
            detail = stderr or f"zstd exited with status {status}"
            raise WorkflowError(f"cannot unpack release archive: {detail}")
    finally:
        process.stdout.close()
        process.stderr.close()


def archive_member_path(member: tarfile.TarInfo) -> PurePosixPath:
    raw = member.name
    if member.type == tarfile.DIRTYPE and raw.endswith("/"):
        raw = raw[:-1]
    path = canonical_relative_path(raw, "release archive")
    if member.type not in {tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE}:
        raise WorkflowError(
            f"release archive contains an unsupported entry: {path.as_posix()}"
        )
    return path


def single_release_root(staging: Path) -> Path:
    entries = list(staging.iterdir())
    if len(entries) != 1 or not entries[0].is_dir() or entries[0].is_symlink():
        raise WorkflowError(
            "release archive must contain exactly one top-level directory"
        )
    return entries[0]


def read_manifest(release: Path) -> ReleaseManifest:
    return _read_manifest(release)


def read_installed_manifest(release: Path) -> ReleaseManifest:
    """Read an activated release without traversing a legacy browser subtree."""
    path = release / MANIFEST_NAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise WorkflowError(f"release manifest is invalid: {error}") from error
    if isinstance(raw, dict) and raw.get("schema") == PACKAGE_SCHEMA:
        return _parse_manifest(raw)
    if isinstance(raw, dict) and raw.get("schema") == 3:
        return _parse_schema3_manifest(raw)
    return _read_legacy_installed_manifest(raw)


def _read_manifest(release: Path) -> ReleaseManifest:
    path = release / MANIFEST_NAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise WorkflowError(f"release manifest is invalid: {error}") from error
    return _parse_manifest(raw)


def _parse_manifest(raw: object) -> ReleaseManifest:
    expected_keys = {
        "schema",
        "build_id",
        "component_build_id",
        "lock_digest",
        "versions",
        "provenance",
        "files",
        "directories",
    }
    if (
        not isinstance(raw, dict)
        or set(raw) != expected_keys
        or raw.get("schema") != PACKAGE_SCHEMA
    ):
        raise WorkflowError("release manifest has an unsupported shape")
    build_id = require_manifest_string(raw, "build_id")
    component_build_id = require_manifest_string(raw, "component_build_id")
    lock_digest = require_manifest_string(raw, "lock_digest")
    versions = require_versions(raw)
    files = raw.get("files")
    directories = raw.get("directories")
    provenance = require_provenance(raw)
    if (
        not isinstance(files, dict)
        or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in files.items()
        )
        or list(files) != sorted(files)
        or not isinstance(directories, list)
        or not all(isinstance(item, str) for item in directories)
        or directories != sorted(set(directories))
    ):
        raise WorkflowError("release manifest has an unsupported shape")
    canonical_files = {
        manifest_relative_path(relative, "file").as_posix(): digest
        for relative, digest in files.items()
    }
    canonical_directories = tuple(
        manifest_relative_path(relative, "directory").as_posix()
        for relative in directories
    )
    if (
        set(canonical_files) != set(files)
        or canonical_directories != tuple(directories)
        or RESERVED_FILES & set(canonical_files)
        or not all(
            is_sha256(digest.encode("ascii", errors="ignore"))
            for digest in canonical_files.values()
        )
    ):
        raise WorkflowError("release manifest has an unsupported shape")
    if (
        "/" in build_id
        or len(component_build_id) != 24
        or not all(character in "0123456789abcdef" for character in component_build_id)
        or not is_sha256(lock_digest.encode("ascii", errors="ignore"))
    ):
        raise WorkflowError("release manifest has an unsupported shape")
    return ReleaseManifest(
        build_id=build_id,
        component_build_id=component_build_id,
        lock_digest=lock_digest,
        versions=versions,
        provenance=provenance,
        files=canonical_files,
        directories=canonical_directories,
    )


def _parse_schema3_manifest(raw: object) -> ReleaseManifest:
    if not isinstance(raw, dict):
        raise WorkflowError("legacy release manifest has an unsupported shape")
    expected = {
        "schema",
        "build_id",
        "component_build_id",
        "project_commit",
        "lock_digest",
        "versions",
        "provenance",
        "files",
        "directories",
    }
    if set(raw) != expected or raw.get("schema") != 3:
        raise WorkflowError("legacy release manifest has an unsupported shape")
    translated = dict(raw)
    translated.pop("project_commit")
    translated["schema"] = PACKAGE_SCHEMA
    return _parse_manifest(translated)


def _read_legacy_installed_manifest(raw: object) -> ReleaseManifest:
    if not isinstance(raw, dict):
        raise WorkflowError("legacy release manifest has an unsupported shape")
    build_id = require_manifest_string(raw, "build_id")
    raw_files = raw.get("files")
    raw_directories = raw.get("directories")
    if not isinstance(raw_files, dict) or not isinstance(raw_directories, list):
        raise WorkflowError("legacy release manifest has an unsupported shape")
    files: dict[str, str] = {}
    for relative, digest in raw_files.items():
        if not isinstance(relative, str) or not relative.startswith("scriptcat/"):
            continue
        canonical = manifest_relative_path(relative, "file").as_posix()
        if not isinstance(digest, str) or not is_sha256(
            digest.encode("ascii", errors="ignore")
        ):
            raise WorkflowError("legacy ScriptCat inventory is invalid")
        files[canonical] = digest
    directories = tuple(
        manifest_relative_path(relative, "directory").as_posix()
        for relative in raw_directories
        if isinstance(relative, str) and relative.startswith("scriptcat/")
    )
    if not files or directories != tuple(sorted(set(directories))):
        raise WorkflowError("legacy ScriptCat inventory is invalid")
    mcp_version = raw.get("mcp_version")
    scriptcat_version = raw.get("scriptcat_version")
    return ReleaseManifest(
        build_id=build_id,
        component_build_id="0" * 24,
        lock_digest="0" * 64,
        versions={
            "chrome_devtools_mcp": (
                mcp_version
                if isinstance(mcp_version, str) and mcp_version
                else "legacy"
            ),
            "scriptcat": (
                scriptcat_version
                if isinstance(scriptcat_version, str) and scriptcat_version
                else "legacy"
            ),
        },
        provenance={},
        files=dict(sorted(files.items())),
        directories=directories,
    )


def require_manifest_string(raw: dict[object, object], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value:
        raise WorkflowError("release manifest has an unsupported shape")
    return value


def require_versions(raw: dict[object, object]) -> dict[str, str]:
    versions = raw.get("versions")
    expected = {"chrome_devtools_mcp", "scriptcat"}
    if (
        not isinstance(versions, dict)
        or set(versions) != expected
        or not all(isinstance(value, str) and value for value in versions.values())
    ):
        raise WorkflowError("release manifest has an unsupported versions shape")
    return {key: versions[key] for key in sorted(expected)}


def require_provenance(raw: dict[object, object]) -> dict[str, dict[str, str]]:
    provenance = raw.get("provenance")
    required = {
        "chrome_devtools_mcp": {"upstream_commit", "build_commit"},
        "scriptcat": {"upstream_commit", "patch_digest", "build_commit"},
    }
    if not isinstance(provenance, dict) or set(provenance) != set(required):
        raise WorkflowError("release manifest has an unsupported provenance shape")
    parsed: dict[str, dict[str, str]] = {}
    for component, keys in required.items():
        values = provenance[component]
        if not isinstance(values, dict) or set(values) != keys:
            raise WorkflowError("release manifest has an unsupported provenance shape")
        parsed_values: dict[str, str] = {}
        for key, value in values.items():
            expected_length = 64 if key == "patch_digest" else 40
            if (
                not isinstance(value, str)
                or len(value) != expected_length
                or any(character not in "0123456789abcdef" for character in value)
            ):
                raise WorkflowError(
                    "release manifest has an unsupported provenance shape"
                )
            parsed_values[key] = value
        parsed[component] = parsed_values
    return parsed


def manifest_relative_path(relative: str, kind: str) -> PurePosixPath:
    return canonical_relative_path(relative, f"release manifest {kind}")


def canonical_relative_path(relative: str, context: str) -> PurePosixPath:
    path = PurePosixPath(relative)
    if (
        not relative
        or path == PurePosixPath(".")
        or path.is_absolute()
        or ".." in path.parts
        or path.as_posix() != relative
    ):
        raise WorkflowError(f"{context} references an unsafe or non-canonical path")
    return path


def verify_manifest(release: Path, manifest: ReleaseManifest) -> None:
    required = {
        "mcp/bin/chrome-devtools-mcp.js",
        "scriptcat/manifest.json",
    }
    if not required.issubset(manifest.files):
        raise WorkflowError("release manifest omits required portable runtime files")
    roots = {
        PurePosixPath(relative).parts[0]
        for relative in (*manifest.files, *manifest.directories)
    }
    if roots != {"mcp", "scriptcat"}:
        raise WorkflowError("release manifest must contain only MCP and ScriptCat")
    actual_files, actual_directories = inspect_release_tree(release)
    expected_files = set(manifest.files) | RESERVED_FILES
    if actual_files != expected_files or actual_directories != set(
        manifest.directories
    ):
        raise WorkflowError("release manifest does not cover the exact release tree")
    for relative, expected in manifest.files.items():
        path = release.joinpath(*PurePosixPath(relative).parts)
        if sha256(path) != expected:
            raise WorkflowError(f"checksum mismatch for {relative}")
    sums = release / CHECKSUMS_NAME
    covered = verify_checksum_file(release, sums)
    expected_covered = set(manifest.files) | {MANIFEST_NAME}
    if covered != expected_covered:
        raise WorkflowError("SHA256SUMS does not cover the exact release contents")


def inspect_release_tree(release: Path) -> tuple[set[str], set[str]]:
    try:
        root_status = release.lstat()
    except FileNotFoundError as error:
        raise WorkflowError(f"release directory is missing: {release}") from error
    if not stat.S_ISDIR(root_status.st_mode):
        raise WorkflowError("release root is not a directory")
    files: set[str] = set()
    directories: set[str] = set()
    for current, directory_names, file_names in os.walk(release, followlinks=False):
        current_path = Path(current)
        for name in directory_names:
            path = current_path / name
            status = path.lstat()
            relative = path.relative_to(release).as_posix()
            if not stat.S_ISDIR(status.st_mode):
                raise WorkflowError(
                    f"release tree contains an unsupported entry: {relative}"
                )
            directories.add(relative)
        for name in file_names:
            path = current_path / name
            status = path.lstat()
            relative = path.relative_to(release).as_posix()
            if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
                raise WorkflowError(
                    f"release tree contains an unsupported entry: {relative}"
                )
            files.add(relative)
    return files, directories


def verify_checksum_file(release: Path, sums: Path) -> set[str]:
    try:
        payload = sums.read_bytes()
    except FileNotFoundError as error:
        raise WorkflowError("release omits SHA256SUMS") from error
    if not payload or not payload.endswith(b"\0"):
        raise WorkflowError("SHA256SUMS must be a NUL-terminated checksum list")
    covered: set[str] = set()
    for record in payload[:-1].split(b"\0"):
        if len(record) < 67 or record[64:66] != b"  ":
            raise WorkflowError("SHA256SUMS is invalid or does not match the release")
        expected = record[:64]
        try:
            relative = record[66:].decode("utf-8")
        except UnicodeDecodeError as error:
            raise WorkflowError("SHA256SUMS contains a non-UTF-8 path") from error
        path = canonical_relative_path(relative, "release checksum")
        canonical = path.as_posix()
        target = release.joinpath(*path.parts)
        try:
            status = target.lstat()
        except FileNotFoundError as error:
            raise WorkflowError(
                "SHA256SUMS is invalid or does not match the release"
            ) from error
        if (
            not is_sha256(expected)
            or canonical in covered
            or not stat.S_ISREG(status.st_mode)
            or status.st_nlink != 1
            or sha256(target) != expected.decode("ascii")
        ):
            raise WorkflowError("SHA256SUMS is invalid or does not match the release")
        covered.add(canonical)
    return covered
