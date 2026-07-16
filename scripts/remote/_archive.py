from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import tarfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from ._common import WorkflowError

MANIFEST_NAME = "manifest.json"
CHECKSUMS_NAME = "SHA256SUMS"
ARCHIVE_DIGEST_SUFFIX = ".sha256"
RESERVED_FILES = frozenset({MANIFEST_NAME, CHECKSUMS_NAME})


@dataclass(frozen=True)
class ReleaseManifest:
    build_id: str
    chromium_version: str
    mcp_version: str
    depot_tools_version: str
    scriptcat_version: str
    provenance: dict[str, dict[str, str]]
    files: dict[str, str]
    directories: tuple[str, ...]


def archive_digest_path(archive: Path) -> Path:
    return Path(f"{archive}{ARCHIVE_DIGEST_SUFFIX}")


def validate_sha256_digest(value: str, label: str) -> None:
    if not is_sha256(value.encode("ascii", errors="ignore")):
        raise WorkflowError(f"{label} must be a lowercase SHA-256 digest")


def read_archive_digest(path: Path) -> str:
    try:
        payload = path.read_bytes()
    except OSError as error:
        raise WorkflowError(f"cannot read archive SHA-256 sidecar: {error}") from error
    if len(payload) != 65 or not payload.endswith(b"\n") or not is_sha256(payload[:-1]):
        raise WorkflowError("archive SHA-256 sidecar is invalid")
    return payload[:-1].decode("ascii")


def copy_verified_archive(
    archive: Path, destination: Path, expected_sha256: str
) -> None:
    validate_sha256_digest(expected_sha256, "expected archive SHA-256")
    digest = hashlib.sha256()
    try:
        with archive.open("rb") as source, destination.open("xb") as output:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
                output.write(chunk)
    except FileNotFoundError as error:
        destination.unlink(missing_ok=True)
        raise WorkflowError(f"release archive is missing: {archive}") from error
    except OSError as error:
        destination.unlink(missing_ok=True)
        raise WorkflowError(f"cannot stage release archive: {error}") from error
    if digest.hexdigest() != expected_sha256:
        destination.unlink()
        raise WorkflowError(
            "release archive SHA-256 does not match the expected digest"
        )


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
    return _read_manifest(release, allow_missing_provenance=False)


def read_installed_manifest(release: Path) -> ReleaseManifest:
    """Read an activated release, including schema-1 predecessors."""
    return _read_manifest(release, allow_missing_provenance=True)


def _read_manifest(release: Path, *, allow_missing_provenance: bool) -> ReleaseManifest:
    path = release / MANIFEST_NAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise WorkflowError(f"release manifest is invalid: {error}") from error
    if not isinstance(raw, dict):
        raise WorkflowError("release manifest has an unsupported shape")
    fields = (
        require_manifest_string(raw, "build_id"),
        require_manifest_string(raw, "chromium_version"),
        require_manifest_string(raw, "mcp_version"),
        require_manifest_string(raw, "depot_tools_version"),
        require_manifest_string(raw, "scriptcat_version"),
    )
    files = raw.get("files")
    directories = raw.get("directories")
    provenance = (
        {}
        if allow_missing_provenance and "provenance" not in raw
        else require_provenance(raw)
    )
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
    build_id, chromium_version, mcp_version, depot_tools_version, scriptcat_version = (
        fields
    )
    if "/" in build_id:
        raise WorkflowError("release manifest has an unsupported shape")
    return ReleaseManifest(
        build_id=build_id,
        chromium_version=chromium_version,
        mcp_version=mcp_version,
        depot_tools_version=depot_tools_version,
        scriptcat_version=scriptcat_version,
        provenance=provenance,
        files=canonical_files,
        directories=canonical_directories,
    )


def require_manifest_string(raw: dict[object, object], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value:
        raise WorkflowError("release manifest has an unsupported shape")
    return value


def require_provenance(raw: dict[object, object]) -> dict[str, dict[str, str]]:
    provenance = raw.get("provenance")
    required = {
        "chromium": {"upstream_commit", "patch_digest", "build_commit"},
        "chrome_devtools_mcp": {"upstream_commit", "build_commit"},
        "depot_tools": {"upstream_commit", "build_commit"},
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
        "chromium/chrome-linux/chrome",
        "mcp/bin/chrome-devtools-mcp.js",
        "scriptcat/manifest.json",
    }
    if not required.issubset(manifest.files):
        raise WorkflowError("release manifest omits required portable runtime files")
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


def is_sha256(value: bytes) -> bool:
    return len(value) == 64 and all(
        character in b"0123456789abcdef" for character in value
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
