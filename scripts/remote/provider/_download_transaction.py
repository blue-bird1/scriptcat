from __future__ import annotations

import fcntl
import json
import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path

from ._archive import read_archive_digest, sha256
from ._common import WorkflowError

JOURNAL_SCHEMA = 1
TOKEN_LENGTH = 32


@dataclass(frozen=True)
class OwnedFile:
    path: Path
    device: int
    inode: int


@dataclass(frozen=True)
class DownloadJournal:
    archive: Path
    sidecar: Path
    archive_temporary: OwnedFile
    sidecar_temporary: OwnedFile
    archive_complete: bool = False


def lock_path(output: Path) -> Path:
    return output.parent / f".{output.name}.download.lock"


def journal_path(archive: Path) -> Path:
    return archive.parent / f".{archive.name}.download-journal"


def journal_temporary(path: Path) -> Path:
    return path.with_name(f"{path.name}.new")


@contextmanager
def output_pair_lock(archive: Path, sidecar: Path) -> Iterator[None]:
    paths = sorted({lock_path(archive), lock_path(sidecar)}, key=str)
    descriptors: list[int] = []
    try:
        for path in paths:
            descriptor = open_lock(path)
            descriptors.append(descriptor)
        yield
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def open_lock(path: Path) -> int:
    flags = os.O_CREAT | os.O_RDWR | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as error:
        raise WorkflowError(
            f"cannot lock provider download outputs: {error}"
        ) from error
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise WorkflowError(f"provider download lock is not a regular file: {path}")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def ensure_available(archive: Path, sidecar: Path) -> None:
    with output_pair_lock(archive, sidecar):
        recover(archive, sidecar)
        ensure_unoccupied(archive, sidecar)


def recover(archive: Path, sidecar: Path) -> bool:
    path = journal_path(archive)
    existing = tuple(
        candidate
        for candidate in (path, journal_temporary(path))
        if candidate.exists() or candidate.is_symlink()
    )
    if not existing:
        ensure_no_unowned_parts(archive, sidecar, frozenset())
        return False

    journals = tuple(read_journal(candidate) for candidate in existing)
    for journal in journals:
        validate_journal(journal, archive, sidecar)
    first = journals[0]
    if any(
        journal_ownership(journal) != journal_ownership(first) for journal in journals
    ):
        raise WorkflowError("provider download journals disagree; preserving all paths")
    journal = replace(
        first,
        archive_complete=any(item.archive_complete for item in journals),
    )
    owned_parts = frozenset(
        (journal.archive_temporary.path, journal.sidecar_temporary.path)
    )
    ensure_no_unowned_parts(archive, sidecar, owned_parts)
    inspect_owned_path(journal.archive_temporary.path, journal.archive_temporary)
    inspect_owned_path(journal.sidecar_temporary.path, journal.sidecar_temporary)
    archive_exists = inspect_owned_path(archive, journal.archive_temporary)
    sidecar_exists = inspect_owned_path(sidecar, journal.sidecar_temporary)

    if journal.archive_complete:
        if (
            not archive_exists
            or not sidecar_exists
            or not digest_matches(archive, sidecar)
        ):
            raise WorkflowError(
                "completed provider download journal does not own a valid output pair"
            )
        cleanup_owned_temporaries(journal)
        remove_journals(existing)
        return True

    rollback_outputs(journal, archive_exists, sidecar_exists)
    cleanup_owned_temporaries(journal)
    remove_journals(existing)
    return False


def ensure_unoccupied(archive: Path, sidecar: Path) -> None:
    for path in (archive, sidecar):
        if path.exists() or path.is_symlink():
            raise WorkflowError(f"refusing to overwrite output: {path}")
    ensure_no_unowned_parts(archive, sidecar, frozenset())


def create_journal(
    archive: Path,
    sidecar: Path,
    archive_temporary: Path,
    sidecar_temporary: Path,
) -> DownloadJournal:
    journal = DownloadJournal(
        archive=archive,
        sidecar=sidecar,
        archive_temporary=owned_file(archive_temporary),
        sidecar_temporary=owned_file(sidecar_temporary),
    )
    persist_journal(journal_path(archive), journal)
    return journal


def mark_archive_complete(journal: DownloadJournal) -> DownloadJournal:
    completed = replace(journal, archive_complete=True)
    persist_journal(journal_path(journal.archive), completed)
    return completed


def finish(journal: DownloadJournal) -> None:
    cleanup_owned_temporaries(journal)
    remove_journals(journal_paths_for_cleanup(journal))


def abort(journal: DownloadJournal) -> None:
    archive_exists = inspect_owned_path(journal.archive, journal.archive_temporary)
    sidecar_exists = inspect_owned_path(journal.sidecar, journal.sidecar_temporary)
    rollback_outputs(journal, archive_exists, sidecar_exists)
    cleanup_owned_temporaries(journal)
    remove_journals(journal_paths_for_cleanup(journal))


def journal_paths_for_cleanup(journal: DownloadJournal) -> tuple[Path, ...]:
    path = journal_path(journal.archive)
    existing = tuple(
        candidate
        for candidate in (path, journal_temporary(path))
        if candidate.exists() or candidate.is_symlink()
    )
    for candidate in existing:
        recorded = read_journal(candidate)
        validate_journal(recorded, journal.archive, journal.sidecar)
        if journal_ownership(recorded) != journal_ownership(journal):
            raise WorkflowError(
                "provider download journal ownership changed; preserving all paths"
            )
    return existing


def owned_file(path: Path) -> OwnedFile:
    identity = path.lstat()
    if not stat.S_ISREG(identity.st_mode):
        raise WorkflowError(
            f"provider download temporary is not a regular file: {path}"
        )
    return OwnedFile(path, identity.st_dev, identity.st_ino)


def persist_journal(path: Path, journal: DownloadJournal) -> None:
    temporary = journal_temporary(path)
    if temporary.exists() or temporary.is_symlink():
        raise WorkflowError(
            f"provider download journal staging path exists: {temporary}"
        )
    payload = json.dumps(
        journal_payload(journal), sort_keys=True, separators=(",", ":")
    )
    try:
        os.symlink(payload, temporary)
        fsync_directory(path.parent)
        os.replace(temporary, path)
        fsync_directory(path.parent)
    except OSError as error:
        raise WorkflowError(
            f"cannot persist provider download journal: {error}"
        ) from error


def read_journal(path: Path) -> DownloadJournal:
    try:
        identity = path.lstat()
        if not stat.S_ISLNK(identity.st_mode):
            raise WorkflowError(f"provider download journal is not a symlink: {path}")
        raw = json.loads(os.readlink(path))
    except WorkflowError:
        raise
    except (OSError, json.JSONDecodeError) as error:
        raise WorkflowError(f"provider download journal is invalid: {error}") from error
    keys = {
        "schema",
        "archive",
        "sidecar",
        "archive_temporary",
        "sidecar_temporary",
        "archive_complete",
    }
    if not isinstance(raw, dict) or set(raw) != keys or raw["schema"] != JOURNAL_SCHEMA:
        raise WorkflowError("provider download journal has an unsupported shape")
    if not isinstance(raw["archive_complete"], bool):
        raise WorkflowError("provider download journal has an unsupported shape")
    return DownloadJournal(
        archive=require_path(raw["archive"]),
        sidecar=require_path(raw["sidecar"]),
        archive_temporary=parse_owned_file(raw["archive_temporary"]),
        sidecar_temporary=parse_owned_file(raw["sidecar_temporary"]),
        archive_complete=raw["archive_complete"],
    )


def validate_journal(journal: DownloadJournal, archive: Path, sidecar: Path) -> None:
    if journal.archive != archive or journal.sidecar != sidecar:
        raise WorkflowError(
            "unfinished provider download does not match requested outputs"
        )
    archive_token = staging_token(journal.archive_temporary.path, archive)
    sidecar_token = staging_token(journal.sidecar_temporary.path, sidecar)
    if archive_token is None or archive_token != sidecar_token:
        raise WorkflowError("provider download journal contains unsafe paths")


def staging_token(path: Path, output: Path) -> str | None:
    prefix = f".{output.name}."
    suffix = ".part"
    if (
        path.parent != output.parent
        or not path.name.startswith(prefix)
        or not path.name.endswith(suffix)
    ):
        return None
    token = path.name[len(prefix) : -len(suffix)]
    if len(token) != TOKEN_LENGTH or any(
        character not in "0123456789abcdef" for character in token
    ):
        return None
    return token


def ensure_no_unowned_parts(
    archive: Path, sidecar: Path, owned: frozenset[Path]
) -> None:
    candidates = set(archive.parent.glob(f".{archive.name}.*.part"))
    candidates.update(sidecar.parent.glob(f".{sidecar.name}.*.part"))
    foreign = sorted(
        str(candidate) for candidate in candidates if candidate not in owned
    )
    if foreign:
        raise WorkflowError(
            f"unowned provider download temporary exists; preserving: {foreign[0]}"
        )


def inspect_owned_path(path: Path, owned: OwnedFile) -> bool:
    try:
        identity = path.lstat()
    except FileNotFoundError:
        return False
    except OSError as error:
        raise WorkflowError(f"cannot inspect provider download path: {path}") from error
    if (identity.st_dev, identity.st_ino) != (owned.device, owned.inode):
        raise WorkflowError(
            f"provider download path is not owned by the transaction: {path}"
        )
    return True


def rollback_outputs(
    journal: DownloadJournal, archive_exists: bool, sidecar_exists: bool
) -> None:
    changed: set[Path] = set()
    for path, exists in (
        (journal.archive, archive_exists),
        (journal.sidecar, sidecar_exists),
    ):
        if exists:
            path.unlink()
            changed.add(path.parent)
    fsync_directories(changed)


def cleanup_owned_temporaries(journal: DownloadJournal) -> None:
    changed: set[Path] = set()
    for owned in (journal.archive_temporary, journal.sidecar_temporary):
        if inspect_owned_path(owned.path, owned):
            owned.path.unlink()
            changed.add(owned.path.parent)
    fsync_directories(changed)


def remove_journals(paths: tuple[Path, ...]) -> None:
    changed: set[Path] = set()
    for path in paths:
        if not stat.S_ISLNK(path.lstat().st_mode):
            raise WorkflowError(f"refusing to remove foreign provider journal: {path}")
        path.unlink()
        changed.add(path.parent)
    fsync_directories(changed)


def digest_matches(archive: Path, sidecar: Path) -> bool:
    try:
        return sha256(archive) == read_archive_digest(sidecar)
    except (OSError, UnicodeDecodeError, WorkflowError):
        return False


def journal_ownership(journal: DownloadJournal) -> tuple[object, ...]:
    return (
        journal.archive,
        journal.sidecar,
        journal.archive_temporary,
        journal.sidecar_temporary,
    )


def journal_payload(journal: DownloadJournal) -> dict[str, object]:
    return {
        "schema": JOURNAL_SCHEMA,
        "archive": str(journal.archive),
        "sidecar": str(journal.sidecar),
        "archive_temporary": owned_payload(journal.archive_temporary),
        "sidecar_temporary": owned_payload(journal.sidecar_temporary),
        "archive_complete": journal.archive_complete,
    }


def owned_payload(owned: OwnedFile) -> dict[str, object]:
    return {"path": str(owned.path), "device": owned.device, "inode": owned.inode}


def parse_owned_file(raw: object) -> OwnedFile:
    if not isinstance(raw, dict) or set(raw) != {"path", "device", "inode"}:
        raise WorkflowError("provider download journal has an unsupported shape")
    device = require_identity(raw["device"])
    inode = require_identity(raw["inode"])
    if inode == 0:
        raise WorkflowError("provider download journal has an unsupported shape")
    return OwnedFile(require_path(raw["path"]), device, inode)


def require_path(value: object) -> Path:
    if not isinstance(value, str) or not value:
        raise WorkflowError("provider download journal has an unsupported shape")
    path = Path(value)
    if not path.is_absolute():
        raise WorkflowError("provider download journal contains a relative path")
    return path


def require_identity(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise WorkflowError("provider download journal has an unsupported shape")
    return value


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_directories(paths: set[Path]) -> None:
    for path in paths:
        fsync_directory(path)
