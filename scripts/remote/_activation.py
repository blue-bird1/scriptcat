from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from ._common import WorkflowError

PROFILE_LOCK_PATH = (
    Path.home()
    / ".codex"
    / "chrome-devtools-scriptcat-chromium-profile"
    / ".scriptcat-mcp.lock"
)


@dataclass(frozen=True)
class ReleaseManifest:
    build_id: str
    chromium_version: str
    mcp_version: str
    depot_tools_version: str
    scriptcat_version: str
    files: dict[str, str]


@dataclass(frozen=True)
class LinkState:
    exists: bool
    target: str | None


def activate_archive(
    archive: Path,
    data_root: Path,
    extension_root: Path,
    expected_build_id: str,
    expected_chromium_version: str,
    expected_mcp_version: str,
    expected_depot_tools_version: str,
    expected_scriptcat_version: str,
) -> str:
    staging = Path("/tmp") / f"scriptcat-mcp-stage-{os.getpid()}"
    if staging.exists():
        raise WorkflowError(f"staging path already exists: {staging}")
    staging.mkdir(mode=0o700)
    try:
        unpack_archive(archive, staging)
        release = single_release_root(staging)
        manifest = read_manifest(release)
        if manifest.build_id != expected_build_id:
            raise WorkflowError("release build_id does not match the requested build")
        if manifest.chromium_version != expected_chromium_version:
            raise WorkflowError(
                "release Chromium version does not match the upstream lock"
            )
        expected_versions = {
            "MCP": (manifest.mcp_version, expected_mcp_version),
            "depot_tools": (
                manifest.depot_tools_version,
                expected_depot_tools_version,
            ),
            "ScriptCat": (manifest.scriptcat_version, expected_scriptcat_version),
        }
        for component, (actual, expected) in expected_versions.items():
            if actual != expected:
                raise WorkflowError(
                    f"release {component} version does not match the upstream lock"
                )
        verify_manifest(release, manifest)
        verify_chromium_binary(release, manifest.chromium_version)
        extension_temporary = prepare_extension(release, extension_root)
        try:
            with profile_lock():
                return commit_activation(
                    release,
                    manifest.build_id,
                    data_root,
                    extension_root,
                    extension_temporary,
                )
        finally:
            remove_tree(extension_temporary)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def unpack_archive(archive: Path, staging: Path) -> None:
    if not archive.is_file():
        raise WorkflowError(f"release archive is missing: {archive}")
    try:
        members = subprocess.run(
            ("tar", "--zstd", "-tf", str(archive)),
            check=True,
            text=True,
            capture_output=True,
        ).stdout.splitlines()
        for member in members:
            path = PurePosixPath(member)
            if path.is_absolute() or ".." in path.parts:
                raise WorkflowError("release archive contains an unsafe path")
        subprocess.run(
            (
                "tar",
                "--zstd",
                "--no-same-owner",
                "--no-same-permissions",
                "-xf",
                str(archive),
                "-C",
                str(staging),
            ),
            check=True,
            text=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as error:
        raise WorkflowError(
            f"cannot unpack release archive: {error.stderr.strip()}"
        ) from error


def single_release_root(staging: Path) -> Path:
    roots = [path for path in staging.iterdir() if path.is_dir()]
    if len(roots) != 1:
        raise WorkflowError(
            "release archive must contain exactly one top-level directory"
        )
    return roots[0]


def read_manifest(release: Path) -> ReleaseManifest:
    path = release / "manifest.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as error:
        raise WorkflowError(f"release manifest is invalid: {error}") from error
    build_id = raw.get("build_id")
    chromium_version = raw.get("chromium_version")
    mcp_version = raw.get("mcp_version")
    depot_tools_version = raw.get("depot_tools_version")
    scriptcat_version = raw.get("scriptcat_version")
    files = raw.get("files")
    if (
        not isinstance(build_id, str)
        or not build_id
        or "/" in build_id
        or not isinstance(chromium_version, str)
        or not chromium_version
        or not isinstance(mcp_version, str)
        or not mcp_version
        or not isinstance(depot_tools_version, str)
        or not depot_tools_version
        or not isinstance(scriptcat_version, str)
        or not scriptcat_version
        or not isinstance(files, dict)
        or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in files.items()
        )
    ):
        raise WorkflowError("release manifest has an unsupported shape")
    return ReleaseManifest(
        build_id,
        chromium_version,
        mcp_version,
        depot_tools_version,
        scriptcat_version,
        files,
    )


def verify_manifest(release: Path, manifest: ReleaseManifest) -> None:
    required = {
        "chromium/chrome-linux/chrome",
        "mcp/bin/chrome-devtools-mcp.js",
        "scriptcat/manifest.json",
    }
    if not required.issubset(manifest.files):
        raise WorkflowError("release manifest omits required portable runtime files")
    for relative, expected in manifest.files.items():
        path = safe_release_path(release, relative)
        if not path.is_file() or len(expected) != 64:
            raise WorkflowError(f"release manifest file is unavailable: {relative}")
        actual = sha256(path)
        if actual != expected:
            raise WorkflowError(f"checksum mismatch for {relative}")
    sums = release / "SHA256SUMS"
    if not sums.is_file():
        raise WorkflowError("release omits SHA256SUMS")
    covered = verify_checksum_file(release, sums)
    expected_covered = set(manifest.files) | {"manifest.json"}
    if covered != expected_covered:
        raise WorkflowError("SHA256SUMS does not cover the exact release contents")


def verify_chromium_binary(release: Path, expected_version: str) -> None:
    executable = release / "chromium" / "chrome-linux" / "chrome"
    if not os.access(executable, os.X_OK):
        raise WorkflowError("portable Chromium entry is not executable")
    try:
        completed = subprocess.run(
            (str(executable), "--version"),
            check=True,
            text=True,
            capture_output=True,
            timeout=30,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise WorkflowError("portable Chromium version probe failed") from error
    if expected_version not in completed.stdout:
        raise WorkflowError("portable Chromium reports an unexpected version")


def verify_checksum_file(release: Path, sums: Path) -> set[str]:
    payload = sums.read_bytes()
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
        path = safe_release_path(release, relative)
        canonical_relative = path.relative_to(release).as_posix()
        if (
            not is_sha256(expected)
            or canonical_relative in covered
            or not path.is_file()
            or sha256(path) != expected.decode("ascii")
        ):
            raise WorkflowError("SHA256SUMS is invalid or does not match the release")
        covered.add(canonical_relative)
    return covered


def safe_release_path(release: Path, relative: str) -> Path:
    path = PurePosixPath(relative)
    if path.is_absolute() or ".." in path.parts:
        raise WorkflowError("release checksum references an unsafe path")
    return release / path


def is_sha256(value: bytes) -> bool:
    return len(value) == 64 and all(
        character in b"0123456789abcdef" for character in value
    )


def prepare_extension(release: Path, extension_root: Path) -> Path:
    source = release / "scriptcat"
    if not source.is_dir():
        raise WorkflowError("release extension directory is missing")
    extension_root.parent.mkdir(parents=True, exist_ok=True)
    temporary = extension_root.with_name(f".{extension_root.name}-{os.getpid()}")
    if temporary.exists():
        raise WorkflowError(f"temporary extension path already exists: {temporary}")
    shutil.copytree(source, temporary, symlinks=True)
    return temporary


def commit_activation(
    release: Path,
    build_id: str,
    data_root: Path,
    extension_root: Path,
    extension_temporary: Path,
) -> str:
    releases = data_root / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    final = releases / build_id
    current = data_root / "current"
    previous = data_root / "previous"
    current_state = capture_link(current)
    previous_state = capture_link(previous)
    rollback_extension = extension_root.with_name(
        f".{extension_root.name}-rollback-{os.getpid()}"
    )
    backup_extension = (
        Path("/backup") / "scriptcat-mcp" / (f"scriptcat-extension-{time.time_ns()}")
    )
    extension_existed = extension_root.exists() or extension_root.is_symlink()
    if rollback_extension.exists() or rollback_extension.is_symlink():
        raise WorkflowError(
            f"rollback extension path already exists: {rollback_extension}"
        )
    if extension_existed:
        backup_extension.parent.mkdir(parents=True, exist_ok=True)
    if final.exists():
        existing_manifest = read_manifest(final)
        verify_manifest(final, existing_manifest)
        if existing_manifest != read_manifest(release):
            raise WorkflowError(
                "existing release conflicts with the requested build_id"
            )
    else:
        os.replace(release, final)
    try:
        if extension_existed:
            os.replace(extension_root, rollback_extension)
        os.replace(extension_temporary, extension_root)
        if current_state.exists:
            assert current_state.target is not None
            replace_symlink(previous, current_state.target)
        else:
            remove_link(previous)
        replace_symlink(current, str(final))
        if extension_existed:
            shutil.move(str(rollback_extension), str(backup_extension))
        return build_id
    except BaseException:
        restore_link(previous, previous_state)
        restore_link(current, current_state)
        remove_tree(extension_root)
        if rollback_extension.exists() or rollback_extension.is_symlink():
            os.replace(rollback_extension, extension_root)
        elif backup_extension.exists() or backup_extension.is_symlink():
            shutil.move(str(backup_extension), str(extension_root))
        raise


def capture_link(path: Path) -> LinkState:
    if not path.exists() and not path.is_symlink():
        return LinkState(False, None)
    if not path.is_symlink():
        raise WorkflowError(f"activation link is not a symlink: {path}")
    return LinkState(True, os.readlink(path))


def restore_link(path: Path, state: LinkState) -> None:
    if state.exists:
        assert state.target is not None
        replace_symlink(path, state.target)
    else:
        remove_link(path)


def remove_link(path: Path) -> None:
    if path.is_symlink():
        path.unlink()
    elif path.exists():
        raise WorkflowError(f"activation link is not a symlink: {path}")


def remove_tree(path: Path) -> None:
    if path.is_symlink():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def replace_symlink(path: Path, target: str) -> None:
    temporary = path.with_name(f".{path.name}-{os.getpid()}")
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    os.replace(temporary, path)


@contextmanager
def profile_lock() -> Iterator[None]:
    PROFILE_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with PROFILE_LOCK_PATH.open("a+", encoding="utf-8") as stream:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise WorkflowError(
                "PROFILE_BUSY: ScriptCat MCP profile is in use"
            ) from error
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
