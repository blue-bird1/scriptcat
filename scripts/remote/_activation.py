from __future__ import annotations

import fcntl
import os
import shutil
import stat
import subprocess
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

from ._activation_state import (
    ActivationJournal,
    ActivationStage,
    LinkState,
    capture_link,
    ensure_transaction_paths_available,
    extension_exists,
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
    inspect_release_tree,
    read_manifest,
    sha256,
    single_release_root,
    unpack_archive,
    verify_manifest,
)
from ._common import WorkflowError

PROFILE_LOCK_PATH = (
    Path.home()
    / ".codex"
    / "chrome-devtools-scriptcat-chromium-profile"
    / ".scriptcat-mcp.lock"
)
ActivationCheckpoint = Callable[[ActivationStage], None]


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
        verify_expected_manifest(
            manifest,
            expected_build_id,
            expected_chromium_version,
            expected_mcp_version,
            expected_depot_tools_version,
            expected_scriptcat_version,
        )
        verify_manifest(release, manifest)
        verify_chromium_binary(release, manifest.chromium_version)
        with profile_lock():
            recover_activation(data_root, extension_root)
            extension_temporary = prepare_extension(release, extension_root)
            try:
                return commit_activation(
                    release,
                    manifest,
                    data_root,
                    extension_root,
                    extension_temporary,
                )
            finally:
                remove_tree(extension_temporary)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


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


def prepare_extension(release: Path, extension_root: Path) -> Path:
    source = release / "scriptcat"
    if not source.is_dir() or source.is_symlink():
        raise WorkflowError("release extension directory is missing")
    extension_root.parent.mkdir(parents=True, exist_ok=True)
    temporary = transaction_paths(Path(), extension_root).extension_temporary
    if temporary.exists() or temporary.is_symlink():
        raise WorkflowError(f"temporary extension path already exists: {temporary}")
    shutil.copytree(source, temporary)
    fsync_tree(temporary)
    return temporary


def commit_activation(
    release: Path,
    manifest: ReleaseManifest,
    data_root: Path,
    extension_root: Path,
    extension_temporary: Path,
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
    previous_state = capture_link(previous)
    extension_existed = extension_exists(extension_root)
    if current_state == LinkState(True, str(final)) and extension_matches_manifest(
        extension_root, manifest
    ):
        return manifest.build_id
    paths = transaction_paths(data_root, extension_root)
    ensure_transaction_paths_available(paths)
    journal = ActivationJournal(
        build_id=manifest.build_id,
        extension_existed=extension_existed,
        current=current_state,
        previous=previous_state,
    )
    try:
        write_journal(paths, journal)
        active_checkpoint(ActivationStage.JOURNAL_WRITTEN)
        if extension_existed:
            os.replace(extension_root, paths.extension_rollback)
            fsync_directory(extension_root.parent)
        active_checkpoint(ActivationStage.EXTENSION_BACKED_UP)
        os.replace(extension_temporary, extension_root)
        fsync_directory(extension_root.parent)
        active_checkpoint(ActivationStage.EXTENSION_INSTALLED)
        if current_state != LinkState(True, str(final)):
            restore_link(previous, current_state)
        active_checkpoint(ActivationStage.PREVIOUS_UPDATED)
        replace_symlink(current, str(final))
        active_checkpoint(ActivationStage.CURRENT_UPDATED)
        remove_journal(paths)
        active_checkpoint(ActivationStage.JOURNAL_REMOVED)
    except BaseException:
        recover_activation(data_root, extension_root)
        raise
    remove_tree(paths.extension_rollback)
    fsync_directory(extension_root.parent)
    return manifest.build_id


def materialize_release(
    release: Path, manifest: ReleaseManifest, releases: Path
) -> Path:
    final = releases / manifest.build_id
    temporary = releases / f".{manifest.build_id}-activation-new"
    if final.exists() or final.is_symlink():
        if not final.is_dir() or final.is_symlink():
            raise WorkflowError(f"existing release path is invalid: {final}")
        existing_manifest = read_manifest(final)
        verify_manifest(final, existing_manifest)
        verify_chromium_binary(final, existing_manifest.chromium_version)
        if existing_manifest != manifest:
            raise WorkflowError(
                "existing release conflicts with the requested build_id"
            )
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
