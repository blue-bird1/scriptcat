from __future__ import annotations

import ctypes
import hashlib
import json
import os
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from ._errors import PublishError
from ._release import (
    Release,
    extension_matches,
    fsync_directory,
    fsync_tree,
    remove_path,
    verify_release,
    write_json,
)

JOURNAL_SCHEMA_VERSION = 1
AT_FDCWD = -100
RENAME_EXCHANGE = 2


class ActivationStage(StrEnum):
    JOURNAL_WRITTEN = "journal-written"
    PREVIOUS_UPDATED = "previous-updated"
    EXTENSION_EXCHANGED = "extension-exchanged"
    EXTENSION_ROLLBACK_STAGED = "extension-rollback-staged"
    CURRENT_UPDATED = "current-updated"
    JOURNAL_REMOVED = "journal-removed"


Checkpoint = Callable[[ActivationStage], None]


@dataclass(frozen=True)
class LinkState:
    target: str | None


@dataclass(frozen=True)
class Journal:
    release_id: str
    extension_existed: bool
    current: LinkState
    previous: LinkState


@dataclass(frozen=True)
class TransactionPaths:
    journal: Path
    journal_new: Path
    extension_new: Path
    extension_rollback: Path


def activate_release(
    release_root: Path,
    release: Release,
    data_root: Path,
    extension_root: Path,
    checkpoint: Checkpoint | None = None,
) -> str:
    active_checkpoint = checkpoint or (lambda stage: None)
    data_root.mkdir(parents=True, exist_ok=True)
    extension_root.parent.mkdir(parents=True, exist_ok=True)
    recover_activation(data_root, extension_root)
    final = release_root.resolve()
    verify_release(final, release)
    current_path = data_root / "current"
    previous_path = data_root / "previous"
    current = capture_link(current_path)
    repairs_current = current.target == str(final)
    if repairs_current and extension_matches(extension_root, release):
        return release.release_id
    if not repairs_current:
        verify_prior_extension(current, extension_root)
    paths = transaction_paths(data_root, extension_root)
    ensure_paths_available(paths)
    stage_extension(final / "extension", paths.extension_new)
    journal = Journal(
        release_id=release.release_id,
        extension_existed=path_exists(extension_root),
        current=current,
        previous=capture_link(previous_path),
    )
    write_journal(paths, journal)
    active_checkpoint(ActivationStage.JOURNAL_WRITTEN)
    if not repairs_current:
        restore_link(previous_path, current)
    active_checkpoint(ActivationStage.PREVIOUS_UPDATED)
    if journal.extension_existed:
        exchange_paths(paths.extension_new, extension_root)
        fsync_directory(extension_root.parent)
        active_checkpoint(ActivationStage.EXTENSION_EXCHANGED)
        os.replace(paths.extension_new, paths.extension_rollback)
    else:
        os.replace(paths.extension_new, extension_root)
    fsync_directory(extension_root.parent)
    active_checkpoint(ActivationStage.EXTENSION_ROLLBACK_STAGED)
    if not repairs_current:
        replace_link(current_path, str(final))
    active_checkpoint(ActivationStage.CURRENT_UPDATED)
    remove_journal(paths)
    active_checkpoint(ActivationStage.JOURNAL_REMOVED)
    remove_path(paths.extension_rollback)
    fsync_directory(extension_root.parent)
    return release.release_id


def recover_activation(data_root: Path, extension_root: Path) -> None:
    paths = transaction_paths(data_root, extension_root)
    journal = read_journal(paths)
    if journal is None:
        cleanup_stale(paths)
        return
    restore_extension(data_root, extension_root, paths, journal)
    restore_link(data_root / "previous", journal.previous)
    restore_link(data_root / "current", journal.current)
    remove_journal(paths)
    cleanup_stale(paths)


def restore_extension(
    data_root: Path,
    extension_root: Path,
    paths: TransactionPaths,
    journal: Journal,
) -> None:
    if not journal.extension_existed:
        remove_path(extension_root)
        remove_path(paths.extension_new)
        fsync_directory(extension_root.parent)
        return
    if path_exists(paths.extension_rollback):
        remove_path(extension_root)
        os.replace(paths.extension_rollback, extension_root)
        fsync_directory(extension_root.parent)
        return
    if not path_exists(paths.extension_new):
        if prior_extension_matches(data_root, extension_root, journal.current):
            return
        raise PublishError("activation journal cannot restore managed extension")
    if journal_repairs_current(data_root, journal):
        restore_repaired_extension(data_root, extension_root, paths, journal)
        return
    extension_is_prior = prior_extension_matches(
        data_root, extension_root, journal.current
    )
    temporary_is_prior = prior_extension_matches(
        data_root, paths.extension_new, journal.current
    )
    if extension_is_prior and not temporary_is_prior:
        remove_path(paths.extension_new)
        return
    if temporary_is_prior and not extension_is_prior:
        exchange_paths(paths.extension_new, extension_root)
        fsync_directory(extension_root.parent)
        remove_path(paths.extension_new)
        fsync_directory(extension_root.parent)
        return
    raise PublishError("activation journal cannot identify the prior extension")


def journal_repairs_current(data_root: Path, journal: Journal) -> bool:
    if journal.current.target is None:
        return False
    expected = (data_root / "releases" / journal.release_id).resolve()
    return Path(journal.current.target) == expected


def restore_repaired_extension(
    data_root: Path,
    extension_root: Path,
    paths: TransactionPaths,
    journal: Journal,
) -> None:
    release = verify_release(data_root / "releases" / journal.release_id)
    extension_is_target = extension_matches(extension_root, release)
    temporary_is_target = extension_matches(paths.extension_new, release)
    if temporary_is_target and not extension_is_target:
        remove_path(paths.extension_new)
        return
    if extension_is_target and not temporary_is_target:
        exchange_paths(paths.extension_new, extension_root)
        fsync_directory(extension_root.parent)
        remove_path(paths.extension_new)
        fsync_directory(extension_root.parent)
        return
    raise PublishError("activation journal cannot identify the repaired extension")


def verify_prior_extension(current: LinkState, extension_root: Path) -> None:
    if not path_exists(extension_root):
        if current.target is not None:
            raise PublishError("active release exists but managed extension is missing")
        return
    if current.target is None:
        raise PublishError("managed extension exists without an active release")
    release = verify_release(Path(current.target))
    if not extension_matches(extension_root, release):
        raise PublishError("managed extension does not match the active release")


def prior_extension_matches(
    data_root: Path, extension_root: Path, current: LinkState
) -> bool:
    del data_root
    if current.target is None:
        return False
    try:
        release = verify_release(Path(current.target))
    except PublishError:
        return False
    return extension_matches(extension_root, release)


def stage_extension(source: Path, destination: Path) -> None:
    try:
        shutil.copytree(source, destination)
        fsync_tree(destination)
        fsync_directory(destination.parent)
    except BaseException:
        remove_path(destination)
        raise


def transaction_paths(data_root: Path, extension_root: Path) -> TransactionPaths:
    namespace = hashlib.sha256(os.fsencode(data_root.resolve())).hexdigest()[:16]
    return TransactionPaths(
        journal=data_root / "activation-journal.json",
        journal_new=data_root / ".activation-journal-new",
        extension_new=extension_root.with_name(
            f".{extension_root.name}-{namespace}-publish-new"
        ),
        extension_rollback=extension_root.with_name(
            f".{extension_root.name}-{namespace}-publish-rollback"
        ),
    )


def ensure_paths_available(paths: TransactionPaths) -> None:
    for path in (
        paths.journal,
        paths.journal_new,
        paths.extension_new,
        paths.extension_rollback,
    ):
        if path.exists() or path.is_symlink():
            raise PublishError(f"publish transaction path already exists: {path}")


def cleanup_stale(paths: TransactionPaths) -> None:
    remove_path(paths.extension_new)
    remove_path(paths.extension_rollback)
    remove_path(paths.journal_new)


def write_journal(paths: TransactionPaths, journal: Journal) -> None:
    payload = {
        "schema_version": JOURNAL_SCHEMA_VERSION,
        "release_id": journal.release_id,
        "extension_existed": journal.extension_existed,
        "current": journal.current.target,
        "previous": journal.previous.target,
    }
    write_json(paths.journal_new, payload)
    os.replace(paths.journal_new, paths.journal)
    fsync_directory(paths.journal.parent)


def read_journal(paths: TransactionPaths) -> Journal | None:
    if not paths.journal.exists() and not paths.journal.is_symlink():
        return None
    if paths.journal.is_symlink() or not paths.journal.is_file():
        raise PublishError("activation journal is not a regular file")
    try:
        raw = json.loads(paths.journal.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PublishError(f"activation journal is invalid: {error}") from error
    expected = {
        "schema_version",
        "release_id",
        "extension_existed",
        "current",
        "previous",
    }
    if not isinstance(raw, dict) or set(raw) != expected:
        raise PublishError("activation journal has an unsupported shape")
    links = (raw["current"], raw["previous"])
    if (
        raw["schema_version"] != JOURNAL_SCHEMA_VERSION
        or not isinstance(raw["release_id"], str)
        or not isinstance(raw["extension_existed"], bool)
        or not all(value is None or is_absolute_path(value) for value in links)
    ):
        raise PublishError("activation journal has an unsupported shape")
    return Journal(
        release_id=raw["release_id"],
        extension_existed=raw["extension_existed"],
        current=LinkState(raw["current"]),
        previous=LinkState(raw["previous"]),
    )


def remove_journal(paths: TransactionPaths) -> None:
    paths.journal.unlink(missing_ok=True)
    paths.journal_new.unlink(missing_ok=True)
    fsync_directory(paths.journal.parent)


def capture_link(path: Path) -> LinkState:
    if not path.exists() and not path.is_symlink():
        return LinkState(None)
    if not path.is_symlink():
        raise PublishError(f"activation link is not a symlink: {path}")
    target = os.readlink(path)
    if not is_absolute_path(target):
        raise PublishError(f"activation link target is not absolute: {path}")
    return LinkState(target)


def restore_link(path: Path, state: LinkState) -> None:
    if state.target is None:
        remove_link(path)
    else:
        replace_link(path, state.target)


def replace_link(path: Path, target: str) -> None:
    if not is_absolute_path(target):
        raise PublishError("activation link target must be absolute")
    temporary = path.with_name(f".{path.name}-publish-link")
    if temporary.exists() or temporary.is_symlink():
        remove_path(temporary)
    temporary.symlink_to(target)
    os.replace(temporary, path)
    fsync_directory(path.parent)


def remove_link(path: Path) -> None:
    if path.is_symlink():
        path.unlink()
        fsync_directory(path.parent)
    elif path.exists():
        raise PublishError(f"activation link is not a symlink: {path}")


def is_absolute_path(value: object) -> bool:
    return isinstance(value, str) and Path(value).is_absolute()


def path_exists(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def exchange_paths(first: Path, second: Path) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise PublishError("atomic extension directory exchange requires renameat2")
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
        raise PublishError(
            f"atomic extension directory exchange failed: {error}"
        ) from error
