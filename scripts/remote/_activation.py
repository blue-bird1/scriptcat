from __future__ import annotations

import ctypes
import fcntl
import hashlib
import json
import os
import shutil
import stat
import subprocess
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from ._activation_state import (
    LinkState,
    capture_link,
    extension_exists,
    fsync_directory,
    remove_tree,
    replace_symlink,
    restore_link,
)
from ._archive import (
    ReleaseManifest,
    copy_verified_archive,
    inspect_release_tree,
    read_manifest,
    sha256,
    single_release_root,
    unpack_archive,
    verify_manifest,
)
from ._common import WorkflowError, validate_build_id

PROFILE_LOCK_PATH = (
    Path.home()
    / ".codex"
    / "chrome-devtools-scriptcat-chromium-profile"
    / ".scriptcat-mcp.lock"
)
AT_FDCWD = -100
RENAME_EXCHANGE = 2


class ActivationStage(StrEnum):
    EXTENSION_REDIRECT_STAGED = "extension-redirect-staged"
    EXTENSION_REDIRECT_PUBLISHED = "extension-redirect-published"
    PREVIOUS_UPDATED = "previous-updated"
    CURRENT_UPDATED = "current-updated"
    CLEANUP_FINISHED = "cleanup-finished"


ActivationCheckpoint = Callable[[ActivationStage], None]


@dataclass(frozen=True)
class ReleaseProvenance:
    component_build_id: str
    project_commit: str
    lock_digest: str


def activate_archive(
    archive: Path,
    data_root: Path,
    extension_root: Path,
    expected_build_id: str,
    expected_chromium_version: str,
    expected_mcp_version: str,
    expected_depot_tools_version: str,
    expected_scriptcat_version: str,
    expected_lock_digest: str | None = None,
    expected_project_commit: str | None = None,
    *,
    expected_archive_sha256: str,
) -> str:
    validate_build_id(expected_build_id, "expected build_id")
    temporary_root = Path("/tmp") / f"scriptcat-mcp-stage-{os.getpid()}"
    if temporary_root.exists():
        raise WorkflowError(f"staging path already exists: {temporary_root}")
    temporary_root.mkdir(mode=0o700)
    staging = temporary_root / "unpacked"
    staging.mkdir()
    try:
        verified_archive = temporary_root / "release.tar.zst"
        copy_verified_archive(archive, verified_archive, expected_archive_sha256)
        unpack_archive(verified_archive, staging)
        release = single_release_root(staging)
        manifest = read_manifest(release)
        verify_expected_manifest(
            manifest,
            expected_build_id,
            expected_chromium_version,
            expected_mcp_version,
            expected_depot_tools_version,
            expected_scriptcat_version,
        )
        if expected_lock_digest is not None or expected_project_commit is not None:
            verify_expected_provenance(
                manifest,
                read_release_provenance(release),
                expected_lock_digest,
                expected_project_commit,
            )
        verify_manifest(release, manifest)
        verify_chromium_binary(release, manifest.chromium_version)
        with profile_lock():
            return commit_activation(
                release,
                manifest,
                data_root,
                extension_root,
            )
    finally:
        shutil.rmtree(temporary_root, ignore_errors=True)


def verify_expected_manifest(
    manifest: ReleaseManifest,
    expected_build_id: str,
    expected_chromium_version: str,
    expected_mcp_version: str,
    expected_depot_tools_version: str,
    expected_scriptcat_version: str,
) -> None:
    expected = {
        "build_id": (manifest.build_id, expected_build_id),
        "Chromium version": (manifest.chromium_version, expected_chromium_version),
        "MCP version": (manifest.mcp_version, expected_mcp_version),
        "depot_tools version": (
            manifest.depot_tools_version,
            expected_depot_tools_version,
        ),
        "ScriptCat version": (
            manifest.scriptcat_version,
            expected_scriptcat_version,
        ),
    }
    for component, (actual, wanted) in expected.items():
        if actual != wanted:
            raise WorkflowError(
                f"release {component} does not match the requested upstream lock"
            )


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


def commit_activation(
    release: Path,
    manifest: ReleaseManifest,
    data_root: Path,
    extension_root: Path,
    checkpoint: ActivationCheckpoint | None = None,
) -> str:
    active_checkpoint = checkpoint or ignore_checkpoint
    data_root.mkdir(parents=True, exist_ok=True)
    releases = data_root / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    final = materialize_release(release, manifest, releases)
    current = data_root / "current"
    previous = data_root / "previous"
    current_state = capture_link(current)
    expected_current = LinkState(True, str(final))
    redirect_target = data_root / "current" / "scriptcat"
    if current_state == expected_current and extension_redirect_is_valid(
        extension_root, redirect_target
    ):
        return manifest.build_id

    ensure_extension_redirect(
        data_root,
        extension_root,
        current_state,
        active_checkpoint,
    )
    if current_state != expected_current:
        restore_link(previous, current_state)
        active_checkpoint(ActivationStage.PREVIOUS_UPDATED)
        replace_symlink(current, str(final))
        active_checkpoint(ActivationStage.CURRENT_UPDATED)
    active_checkpoint(ActivationStage.CLEANUP_FINISHED)
    return manifest.build_id


def ensure_extension_redirect(
    data_root: Path,
    extension_root: Path,
    current_state: LinkState,
    checkpoint: ActivationCheckpoint,
) -> None:
    redirect_target = data_root / "current" / "scriptcat"
    extension_root.parent.mkdir(parents=True, exist_ok=True)
    migration = extension_migration_path(extension_root)
    if extension_redirect_is_valid(extension_root, redirect_target):
        if migration.exists() or migration.is_symlink():
            remove_tree(migration)
            fsync_directory(extension_root.parent)
        return

    try:
        extension_status = extension_root.lstat()
    except FileNotFoundError:
        extension_status = None
    if extension_status is not None and stat.S_ISLNK(extension_status.st_mode):
        raise WorkflowError(
            f"managed extension redirect has an unexpected target: {extension_root}"
        )
    if extension_status is not None and not stat.S_ISDIR(extension_status.st_mode):
        raise WorkflowError(f"managed extension path is invalid: {extension_root}")
    if extension_status is not None:
        verify_legacy_extension(extension_root, data_root / "current", current_state)

    remove_tree(migration)
    migration.symlink_to(redirect_target, target_is_directory=True)
    checkpoint(ActivationStage.EXTENSION_REDIRECT_STAGED)
    if extension_status is None:
        os.replace(migration, extension_root)
    else:
        exchange_paths(migration, extension_root)
    fsync_directory(extension_root.parent)
    checkpoint(ActivationStage.EXTENSION_REDIRECT_PUBLISHED)
    remove_tree(migration)
    fsync_directory(extension_root.parent)


def verify_legacy_extension(
    extension_root: Path,
    current: Path,
    current_state: LinkState,
) -> None:
    if not current_state.exists or current_state.target is None:
        raise WorkflowError(
            "cannot atomically migrate a managed extension without an active release"
        )
    active_release = Path(current_state.target)
    if not active_release.is_absolute():
        active_release = current.parent / active_release
    active_manifest = read_manifest(active_release)
    verify_manifest(active_release, active_manifest)
    if not extension_matches_manifest(extension_root, active_manifest):
        raise WorkflowError(
            "managed extension does not match the active release; refusing migration"
        )


def extension_redirect_is_valid(extension_root: Path, target: Path) -> bool:
    try:
        status = extension_root.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(status.st_mode) and os.readlink(extension_root) == str(target)


def extension_migration_path(extension_root: Path) -> Path:
    return extension_root.with_name(f".{extension_root.name}-activation-migration")


def exchange_paths(first: Path, second: Path) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise WorkflowError("atomic extension migration requires renameat2")
    renameat2.argtypes = (
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    )
    renameat2.restype = ctypes.c_int
    result = renameat2(
        AT_FDCWD,
        os.fsencode(first),
        AT_FDCWD,
        os.fsencode(second),
        RENAME_EXCHANGE,
    )
    if result != 0:
        error = OSError(ctypes.get_errno(), "renameat2(RENAME_EXCHANGE) failed")
        raise WorkflowError(f"atomic extension migration failed: {error}") from error


def read_release_provenance(release: Path) -> ReleaseProvenance:
    manifest_path = release / "manifest.json"
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise WorkflowError(f"release provenance is invalid: {error}") from error
    if not isinstance(raw, dict):
        raise WorkflowError("release provenance is invalid")
    component_build_id = raw.get("component_build_id")
    project_commit = raw.get("project_commit")
    lock_digest = raw.get("lock_digest")
    if not all(
        isinstance(value, str)
        for value in (
            component_build_id,
            project_commit,
            lock_digest,
        )
    ):
        raise WorkflowError("release provenance is missing or invalid")
    validate_build_id(component_build_id, "release component build ID")
    validate_project_commit(project_commit, "release project commit")
    validate_lock_digest(lock_digest, "release lock digest")
    return ReleaseProvenance(
        component_build_id=component_build_id,
        project_commit=project_commit,
        lock_digest=lock_digest,
    )


def verify_expected_provenance(
    manifest: ReleaseManifest,
    provenance: ReleaseProvenance,
    expected_lock_digest: str | None,
    expected_project_commit: str | None,
) -> None:
    if expected_lock_digest is None and expected_project_commit is None:
        return
    if expected_lock_digest is None:
        raise WorkflowError("release provenance lock digest is required")
    validate_lock_digest(expected_lock_digest, "expected lock digest")
    selected_project_commit = expected_project_commit or provenance.project_commit
    validate_project_commit(selected_project_commit, "expected project commit")
    expected_component_build_id = component_build_id(
        expected_lock_digest, selected_project_commit
    )
    expected_release_build_id = release_build_id(
        expected_component_build_id, selected_project_commit
    )
    expected = {
        "lock digest": (provenance.lock_digest, expected_lock_digest),
        "project commit": (provenance.project_commit, selected_project_commit),
        "component build ID": (
            provenance.component_build_id,
            expected_component_build_id,
        ),
        "release build ID": (manifest.build_id, expected_release_build_id),
    }
    for component, (actual, wanted) in expected.items():
        if actual != wanted:
            raise WorkflowError(
                f"release {component} does not match the requested provenance"
            )


def component_build_id(lock_digest: str, project_commit: str) -> str:
    return hashlib.sha256(f"{lock_digest}{project_commit}".encode()).hexdigest()[:24]


def release_build_id(component_build_id: str, project_commit: str) -> str:
    source = f"{component_build_id}{project_commit}".encode()
    return hashlib.sha256(source).hexdigest()[:24]


def validate_project_commit(value: str, label: str) -> None:
    if len(value) != 40 or any(
        character not in "0123456789abcdef" for character in value
    ):
        raise WorkflowError(f"{label} must be a lowercase 40-hex Git commit")


def validate_lock_digest(value: str, label: str) -> None:
    if len(value) != 64 or any(
        character not in "0123456789abcdef" for character in value
    ):
        raise WorkflowError(f"{label} must be a lowercase SHA-256 digest")


def materialize_release(
    release: Path, manifest: ReleaseManifest, releases: Path
) -> Path:
    final = releases / manifest.build_id
    temporary = releases / f".{manifest.build_id}-activation-new"
    if final.exists() or final.is_symlink():
        if not final.is_dir() or final.is_symlink():
            raise WorkflowError(f"existing release path is invalid: {final}")
        try:
            existing_manifest_bytes = (final / "manifest.json").read_bytes()
            trusted_manifest_bytes = (release / "manifest.json").read_bytes()
        except OSError as error:
            raise WorkflowError(
                f"cannot compare existing release metadata: {error}"
            ) from error
        if existing_manifest_bytes != trusted_manifest_bytes:
            raise WorkflowError(
                "existing release conflicts with the requested build_id"
            )
        verify_manifest(final, manifest)
        verify_chromium_binary(final, manifest.chromium_version)
        return final
    remove_tree(temporary)
    try:
        shutil.copytree(release, temporary)
        verify_manifest(temporary, manifest)
        verify_chromium_binary(temporary, manifest.chromium_version)
        fsync_tree(temporary)
        os.replace(temporary, final)
        fsync_directory(releases)
    finally:
        remove_tree(temporary)
    return final


def extension_matches_manifest(extension_root: Path, manifest: ReleaseManifest) -> bool:
    if not extension_exists(extension_root):
        return False
    try:
        files, directories = inspect_release_tree(extension_root)
    except WorkflowError:
        return False
    prefix = "scriptcat/"
    expected_files = {
        relative.removeprefix(prefix): digest
        for relative, digest in manifest.files.items()
        if relative.startswith(prefix)
    }
    expected_directories = {
        relative.removeprefix(prefix)
        for relative in manifest.directories
        if relative.startswith(prefix)
    }
    if files != set(expected_files) or directories != expected_directories:
        return False
    return all(
        sha256(extension_root / relative) == digest
        for relative, digest in expected_files.items()
    )


def fsync_tree(root: Path) -> None:
    directories: list[Path] = []
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        current_path = Path(current)
        directories.append(current_path)
        for name in directory_names:
            path = current_path / name
            if path.is_symlink():
                raise WorkflowError(f"transaction tree contains a symlink: {path}")
        for name in file_names:
            path = current_path / name
            status = path.lstat()
            if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
                raise WorkflowError(
                    f"transaction tree contains an unsupported entry: {path}"
                )
            with path.open("rb") as stream:
                os.fsync(stream.fileno())
    for directory in reversed(directories):
        fsync_directory(directory)


def ignore_checkpoint(stage: ActivationStage) -> None:
    del stage


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
