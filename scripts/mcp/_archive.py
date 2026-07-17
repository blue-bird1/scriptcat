from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from ._common import WorkflowError
from ._identity import PACKAGE_SCHEMA

if __package__.startswith("scripts."):
    from scripts.release_tools.archive import (
        ARCHIVE_DIGEST_SUFFIX,
        archive_digest_path,
        canonical_relative_path,
        copy_verified_archive,
        is_sha256,
        read_archive_digest,
        sha256,
        single_release_root,
        unpack_archive,
        validate_sha256_digest,
        verify_checksum_file,
    )
else:
    from release_tools.archive import (
        ARCHIVE_DIGEST_SUFFIX,
        archive_digest_path,
        canonical_relative_path,
        copy_verified_archive,
        is_sha256,
        read_archive_digest,
        sha256,
        single_release_root,
        unpack_archive,
        validate_sha256_digest,
        verify_checksum_file,
    )

__all__ = (
    "ARCHIVE_DIGEST_SUFFIX",
    "archive_digest_path",
    "copy_verified_archive",
    "read_archive_digest",
    "sha256",
    "single_release_root",
    "unpack_archive",
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


def read_manifest(release: Path) -> ReleaseManifest:
    return _read_manifest(release)


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


def require_manifest_string(raw: dict[object, object], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value:
        raise WorkflowError("release manifest has an unsupported shape")
    return value


def require_versions(raw: dict[object, object]) -> dict[str, str]:
    versions = raw.get("versions")
    expected = {"chrome_devtools_mcp"}
    if (
        not isinstance(versions, dict)
        or set(versions) != expected
        or not all(isinstance(value, str) and value for value in versions.values())
    ):
        raise WorkflowError("release manifest has an unsupported versions shape")
    return {key: versions[key] for key in sorted(expected)}


def require_provenance(raw: dict[object, object]) -> dict[str, dict[str, str]]:
    provenance = raw.get("provenance")
    required = {"chrome_devtools_mcp": {"upstream_commit", "build_commit"}}
    if not isinstance(provenance, dict) or set(provenance) != set(required):
        raise WorkflowError("release manifest has an unsupported provenance shape")
    parsed: dict[str, dict[str, str]] = {}
    for component, keys in required.items():
        values = provenance[component]
        if not isinstance(values, dict) or set(values) != keys:
            raise WorkflowError("release manifest has an unsupported provenance shape")
        parsed_values: dict[str, str] = {}
        for key, value in values.items():
            expected_length = 40
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


def verify_manifest(release: Path, manifest: ReleaseManifest) -> None:
    required = {"mcp/bin/chrome-devtools-mcp.js"}
    if not required.issubset(manifest.files):
        raise WorkflowError("release manifest omits required portable runtime files")
    roots = {
        PurePosixPath(relative).parts[0]
        for relative in (*manifest.files, *manifest.directories)
    }
    if roots != {"mcp"}:
        raise WorkflowError("release manifest must contain only MCP runtime files")
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
