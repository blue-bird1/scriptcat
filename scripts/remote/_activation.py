from __future__ import annotations

import fcntl
import os
import shutil
import tempfile
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
    fsync_directory,
    recover_activation,
    remove_journal,
    replace_symlink,
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
from ._verified_build import component_build_id, release_build_id

ACTIVATION_LOCK_NAME = ".activation.lock"


class ActivationStage(StrEnum):
    PREVIOUS_UPDATED = "previous-updated"
    CURRENT_UPDATED = "current-updated"
    CLEANUP_FINISHED = "cleanup-finished"


ActivationCheckpoint = Callable[[ActivationStage], None]


@dataclass(frozen=True)
class ReleaseProvenance:
    component_build_id: str
    lock_digest: str


def activate_archive(
    archive: Path,
    data_root: Path,
    expected_build_id: str,
    expected_mcp_version: str,
    expected_lock_digest: str | None = None,
    *,
    expected_archive_sha256: str,
    expected_source_provenance: dict[str, dict[str, str]] | None = None,
) -> str:
    validate_build_id(expected_build_id, "expected build_id")
    with tempfile.TemporaryDirectory(
        dir="/tmp", prefix="scriptcat-mcp-stage-"
    ) as temporary_name:
        temporary_root = Path(temporary_name)
        staging = temporary_root / "unpacked"
        staging.mkdir()
        verified_archive = temporary_root / "release.tar.zst"
        copy_verified_archive(archive, verified_archive, expected_archive_sha256)
        unpack_archive(verified_archive, staging)
        release = single_release_root(staging)
        manifest = read_manifest(release)
        verify_expected_manifest(manifest, expected_build_id, expected_mcp_version)
        if expected_lock_digest is not None:
            verify_expected_provenance(
                manifest, read_release_provenance(release), expected_lock_digest
            )
        verify_source_provenance(manifest, expected_source_provenance)
        verify_manifest(release, manifest)
        verify_release_identity(manifest)
        with activation_lock(data_root):
            return commit_activation(release, manifest, data_root)


def verify_expected_manifest(
    manifest: ReleaseManifest, expected_build_id: str, expected_mcp_version: str
) -> None:
    expected = {
        "build_id": (manifest.build_id, expected_build_id),
        "MCP version": (manifest.mcp_version, expected_mcp_version),
    }
    for component, (actual, wanted) in expected.items():
        if actual != wanted:
            raise WorkflowError(
                f"release {component} does not match the requested upstream lock"
            )


def commit_activation(
    release: Path,
    manifest: ReleaseManifest,
    data_root: Path,
    checkpoint: ActivationCheckpoint | None = None,
) -> str:
    active_checkpoint = checkpoint or ignore_checkpoint
    data_root.mkdir(parents=True, exist_ok=True)
    recover_activation(data_root)
    releases = data_root / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    final = materialize_release(release, manifest, releases)
    current = data_root / "current"
    previous = data_root / "previous"
    current_state = capture_link(current)
    expected_current = LinkState(True, str(final))
    if current_state == expected_current:
        return manifest.build_id
    paths = transaction_paths(data_root)
    ensure_transaction_paths_available(paths)
    write_journal(
        paths,
        ActivationJournal(
            build_id=manifest.build_id,
            current=current_state,
            previous=capture_link(previous),
        ),
    )
    if current_state.exists:
        replace_symlink(previous, current_state.target or "")
    else:
        previous.unlink(missing_ok=True)
        fsync_directory(previous.parent)
    active_checkpoint(ActivationStage.PREVIOUS_UPDATED)
    replace_symlink(current, str(final))
    active_checkpoint(ActivationStage.CURRENT_UPDATED)
    remove_journal(paths)
    active_checkpoint(ActivationStage.CLEANUP_FINISHED)
    return manifest.build_id


def read_release_provenance(release: Path) -> ReleaseProvenance:
    manifest = read_manifest(release)
    return ReleaseProvenance(
        component_build_id=manifest.component_build_id,
        lock_digest=manifest.lock_digest,
    )


def verify_expected_provenance(
    manifest: ReleaseManifest, provenance: ReleaseProvenance, expected_lock_digest: str
) -> None:
    validate_lock_digest(expected_lock_digest, "expected lock digest")
    expected_component = component_build_id(expected_lock_digest)
    if provenance.lock_digest != expected_lock_digest:
        raise WorkflowError("release lock digest does not match the requested lock")
    if provenance.component_build_id != expected_component:
        raise WorkflowError(
            "release component build ID does not match the requested lock"
        )
    if manifest.component_build_id != expected_component:
        raise WorkflowError(
            "release manifest component build ID does not match its provenance"
        )


def verify_source_provenance(
    manifest: ReleaseManifest,
    expected: dict[str, dict[str, str]] | None,
) -> None:
    if expected is not None and manifest.provenance != expected:
        raise WorkflowError(
            "release source provenance does not match the requested lock"
        )


def verify_release_identity(manifest: ReleaseManifest) -> None:
    expected = release_build_id(
        manifest.component_build_id, manifest.files, manifest.directories
    )
    if manifest.build_id != expected:
        raise WorkflowError(
            "release build ID does not match its component and runtime inventory"
        )


def validate_lock_digest(value: str, label: str) -> None:
    if len(value) != 64 or any(
        character not in "0123456789abcdef" for character in value
    ):
        raise WorkflowError(f"{label} must be a lowercase SHA-256 digest")


def materialize_release(
    release: Path, manifest: ReleaseManifest, releases: Path
) -> Path:
    final = releases / manifest.build_id
    if final.exists() or final.is_symlink():
        if final.is_symlink() or not final.is_dir():
            raise WorkflowError(f"release path is invalid: {final}")
        installed = read_manifest(final)
        if installed != manifest:
            raise WorkflowError(
                "existing release manifest differs from requested release"
            )
        verify_manifest(final, installed)
        return final
    temporary = releases / f".{manifest.build_id}-new"
    if temporary.is_symlink() or (temporary.exists() and not temporary.is_dir()):
        raise WorkflowError(f"release staging path already exists: {temporary}")
    if temporary.is_dir():
        shutil.rmtree(temporary)
    try:
        shutil.copytree(release, temporary, copy_function=shutil.copy2)
        verify_manifest(temporary, read_manifest(temporary))
        fsync_tree(temporary)
        os.replace(temporary, final)
        fsync_directory(releases)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return final


def fsync_tree(root: Path) -> None:
    for current, directory_names, file_names in os.walk(root):
        directory = Path(current)
        for name in file_names:
            with (directory / name).open("rb") as stream:
                os.fsync(stream.fileno())
        for name in directory_names:
            fsync_directory(directory / name)
    fsync_directory(root)


def ignore_checkpoint(stage: ActivationStage) -> None:
    del stage


@contextmanager
def activation_lock(data_root: Path) -> Iterator[None]:
    data_root.mkdir(parents=True, exist_ok=True)
    path = data_root / ACTIVATION_LOCK_NAME
    with path.open("a+", encoding="utf-8") as stream:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise WorkflowError("another MCP activation is already running") from error
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
