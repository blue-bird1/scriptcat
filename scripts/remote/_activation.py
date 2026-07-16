from __future__ import annotations

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
    ActivationJournal,
    LinkState,
    capture_link,
    ensure_transaction_paths_available,
    exchange_paths,
    extension_matches_manifest,
    fsync_directory,
    recover_activation,
    remove_journal,
    remove_tree,
    replace_symlink,
    restore_link,
    transaction_paths,
    write_journal,
)
from ._archive import (
    ReleaseManifest,
    copy_verified_archive,
    read_manifest,
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


class ActivationStage(StrEnum):
    EXTENSION_DIRECTORY_STAGED = "extension-directory-staged"
    EXTENSION_DIRECTORY_PUBLISHED = "extension-directory-published"
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
    expected_source_provenance: dict[str, dict[str, str]] | None = None,
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
        verify_source_provenance(manifest, expected_source_provenance)
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
    recover_activation(data_root, extension_root)
    releases = data_root / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    final = materialize_release(release, manifest, releases)
    current = data_root / "current"
    previous = data_root / "previous"
    current_state = capture_link(current)
    expected_current = LinkState(True, str(final))
    if current_state == expected_current and extension_directory_is_valid(
        extension_root, manifest
    ):
        return manifest.build_id

    verify_existing_extension(
        data_root,
        extension_root,
        current_state,
    )
    extension_root.parent.mkdir(parents=True, exist_ok=True)
    paths = transaction_paths(data_root, extension_root)
    ensure_transaction_paths_available(paths)
    write_journal(
        paths,
        ActivationJournal(
            build_id=manifest.build_id,
            extension_existed=extension_path_exists(extension_root),
            current=current_state,
            previous=capture_link(previous),
        ),
    )
    stage_extension_directory(final, manifest, paths.extension_temporary)
    active_checkpoint(ActivationStage.EXTENSION_DIRECTORY_STAGED)
    if current_state != expected_current:
        restore_link(previous, current_state)
        active_checkpoint(ActivationStage.PREVIOUS_UPDATED)
    publish_extension_directory(
        extension_root,
        paths.extension_temporary,
        paths.extension_rollback,
    )
    if current_state != expected_current:
        replace_symlink(current, str(final))
        active_checkpoint(ActivationStage.CURRENT_UPDATED)
    active_checkpoint(ActivationStage.EXTENSION_DIRECTORY_PUBLISHED)
    remove_journal(paths)
    remove_tree(paths.extension_rollback)
    fsync_directory(extension_root.parent)
    active_checkpoint(ActivationStage.CLEANUP_FINISHED)
    return manifest.build_id


def verify_existing_extension(
    data_root: Path,
    extension_root: Path,
    current_state: LinkState,
) -> None:
    if not extension_path_exists(extension_root):
        return
    if extension_root.is_symlink():
        expected_target = data_root / "current" / "scriptcat"
        if os.readlink(extension_root) != str(expected_target):
            raise WorkflowError(
                f"managed extension path has an unexpected target: {extension_root}"
            )
        verify_legacy_extension(extension_root, data_root / "current", current_state)
        return
    try:
        extension_status = extension_root.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(extension_status.st_mode):
        raise WorkflowError(f"managed extension path is invalid: {extension_root}")
    verify_legacy_extension(extension_root, data_root / "current", current_state)


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
    if extension_root.is_symlink():
        return
    if not extension_matches_manifest(extension_root, active_manifest):
        raise WorkflowError(
            "managed extension does not match the active release; refusing migration"
        )


def extension_directory_is_valid(
    extension_root: Path, manifest: ReleaseManifest
) -> bool:
    return extension_matches_manifest(extension_root, manifest)


def extension_path_exists(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def stage_extension_directory(
    release: Path,
    manifest: ReleaseManifest,
    temporary: Path,
) -> None:
    try:
        shutil.copytree(release / "scriptcat", temporary)
        if not extension_matches_manifest(temporary, manifest):
            raise WorkflowError(
                "staged managed extension does not match release manifest"
            )
        fsync_tree(temporary)
        fsync_directory(temporary.parent)
    except BaseException:
        remove_tree(temporary)
        raise


def publish_extension_directory(
    extension_root: Path,
    temporary: Path,
    rollback: Path,
) -> None:
    extension_root.parent.mkdir(parents=True, exist_ok=True)
    if extension_path_exists(extension_root):
        exchange_paths(temporary, extension_root)
        fsync_directory(extension_root.parent)
        os.replace(temporary, rollback)
        fsync_directory(extension_root.parent)
        return
    os.replace(temporary, extension_root)
    fsync_directory(extension_root.parent)


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


def verify_source_provenance(
    manifest: ReleaseManifest, expected: dict[str, dict[str, str]] | None
) -> None:
    if expected is None:
        return
    for component, fields in expected.items():
        actual = manifest.provenance.get(component)
        if actual is None or any(
            actual.get(key) != value for key, value in fields.items()
        ):
            raise WorkflowError(
                "release source provenance does not match the selected lock"
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
