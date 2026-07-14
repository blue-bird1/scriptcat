from __future__ import annotations

import json
import os
import shutil
import stat
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from ._common import WorkflowError

JOURNAL_SCHEMA_VERSION = 1


class ActivationStage(StrEnum):
    JOURNAL_WRITTEN = "journal-written"
    EXTENSION_BACKED_UP = "extension-backed-up"
    EXTENSION_INSTALLED = "extension-installed"
    PREVIOUS_UPDATED = "previous-updated"
    CURRENT_UPDATED = "current-updated"
    JOURNAL_REMOVED = "journal-removed"


@dataclass(frozen=True)
class LinkState:
    exists: bool
    target: str | None


@dataclass(frozen=True)
class ActivationJournal:
    build_id: str
    extension_existed: bool
    current: LinkState
    previous: LinkState


@dataclass(frozen=True)
class TransactionPaths:
    journal: Path
    journal_temporary: Path
    extension_temporary: Path
    extension_rollback: Path


def recover_activation(data_root: Path, extension_root: Path) -> None:
    paths = transaction_paths(data_root, extension_root)
    journal = read_journal(paths)
    if journal is None:
        cleanup_stale_transaction_paths(paths, data_root)
        return
    if journal.extension_existed:
        if paths.extension_rollback.exists() or paths.extension_rollback.is_symlink():
            remove_tree(extension_root)
            os.replace(paths.extension_rollback, extension_root)
            fsync_directory(extension_root.parent)
        elif not extension_exists(extension_root):
            raise WorkflowError("activation journal cannot restore the prior extension")
    else:
        remove_tree(extension_root)
        fsync_directory(extension_root.parent)
    remove_tree(paths.extension_temporary)
    restore_link(data_root / "previous", journal.previous)
    restore_link(data_root / "current", journal.current)
    remove_journal(paths)
    cleanup_stale_transaction_paths(paths, data_root)


def transaction_paths(data_root: Path, extension_root: Path) -> TransactionPaths:
    return TransactionPaths(
        journal=data_root / "activation-journal.json",
        journal_temporary=data_root / ".activation-journal.json-new",
        extension_temporary=extension_root.with_name(
            f".{extension_root.name}-activation-new"
        ),
        extension_rollback=extension_root.with_name(
            f".{extension_root.name}-activation-rollback"
        ),
    )


def ensure_transaction_paths_available(paths: TransactionPaths) -> None:
    for path in (
        paths.journal,
        paths.journal_temporary,
        paths.extension_rollback,
    ):
        if path.exists() or path.is_symlink():
            raise WorkflowError(f"activation transaction path already exists: {path}")


def cleanup_stale_transaction_paths(paths: TransactionPaths, data_root: Path) -> None:
    remove_tree(paths.extension_temporary)
    remove_tree(paths.extension_rollback)
    remove_tree(paths.journal_temporary)
    cleanup_link_temporary(data_root / "current")
    cleanup_link_temporary(data_root / "previous")


def write_journal(paths: TransactionPaths, journal: ActivationJournal) -> None:
    payload = {
        "schema_version": JOURNAL_SCHEMA_VERSION,
        "build_id": journal.build_id,
        "extension_existed": journal.extension_existed,
        "current": link_state_payload(journal.current),
        "previous": link_state_payload(journal.previous),
    }
    paths.journal.parent.mkdir(parents=True, exist_ok=True)
    try:
        with paths.journal_temporary.open("x", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(paths.journal_temporary, paths.journal)
        fsync_directory(paths.journal.parent)
    except BaseException:
        remove_tree(paths.journal_temporary)
        raise


def read_journal(paths: TransactionPaths) -> ActivationJournal | None:
    if not paths.journal.exists() and not paths.journal.is_symlink():
        return None
    if paths.journal.is_symlink() or not paths.journal.is_file():
        raise WorkflowError("activation journal is not a regular file")
    try:
        raw = json.loads(paths.journal.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise WorkflowError(f"activation journal is invalid: {error}") from error
    if not isinstance(raw, dict) or set(raw) != {
        "schema_version",
        "build_id",
        "extension_existed",
        "current",
        "previous",
    }:
        raise WorkflowError("activation journal has an unsupported shape")
    build_id = raw["build_id"]
    extension_existed = raw["extension_existed"]
    if (
        raw["schema_version"] != JOURNAL_SCHEMA_VERSION
        or not isinstance(build_id, str)
        or not build_id
        or "/" in build_id
        or not isinstance(extension_existed, bool)
    ):
        raise WorkflowError("activation journal has an unsupported shape")
    return ActivationJournal(
        build_id=build_id,
        extension_existed=extension_existed,
        current=parse_link_state(raw["current"]),
        previous=parse_link_state(raw["previous"]),
    )


def remove_journal(paths: TransactionPaths) -> None:
    paths.journal.unlink(missing_ok=True)
    paths.journal_temporary.unlink(missing_ok=True)
    fsync_directory(paths.journal.parent)


def link_state_payload(state: LinkState) -> dict[str, bool | str | None]:
    return {"exists": state.exists, "target": state.target}


def parse_link_state(raw: object) -> LinkState:
    if not isinstance(raw, dict) or set(raw) != {"exists", "target"}:
        raise WorkflowError("activation journal link state is invalid")
    exists = raw["exists"]
    target = raw["target"]
    if (
        not isinstance(exists, bool)
        or (exists and (not isinstance(target, str) or not target))
        or (not exists and target is not None)
    ):
        raise WorkflowError("activation journal link state is invalid")
    return LinkState(exists=exists, target=target)


def extension_exists(path: Path) -> bool:
    if not path.exists() and not path.is_symlink():
        return False
    try:
        status = path.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(status.st_mode):
        raise WorkflowError(f"managed extension path is not a directory: {path}")
    return True


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
        fsync_directory(path.parent)
    elif path.exists():
        raise WorkflowError(f"activation link is not a symlink: {path}")


def remove_tree(path: Path) -> None:
    try:
        status = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISDIR(status.st_mode):
        shutil.rmtree(path)
    else:
        path.unlink()


def replace_symlink(path: Path, target: str) -> None:
    temporary = link_temporary(path)
    if temporary.exists() or temporary.is_symlink():
        if not temporary.is_symlink():
            raise WorkflowError(f"activation link temporary is invalid: {temporary}")
        temporary.unlink()
    temporary.symlink_to(target)
    os.replace(temporary, path)
    fsync_directory(path.parent)


def cleanup_link_temporary(path: Path) -> None:
    temporary = link_temporary(path)
    if temporary.is_symlink():
        temporary.unlink()
        fsync_directory(temporary.parent)
    elif temporary.exists():
        raise WorkflowError(f"activation link temporary is invalid: {temporary}")


def link_temporary(path: Path) -> Path:
    return path.with_name(f".{path.name}-activation-link")


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
