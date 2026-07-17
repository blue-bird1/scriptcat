from __future__ import annotations

import os
import secrets
from dataclasses import replace
from pathlib import Path

from ._archive import sha256
from ._common import WorkflowError
from ._package_journal import (
    JOURNAL_NAME,
    PackageExpectation,
    PackageJournal,
    PackageOutput,
    StagedFile,
    fsync_directory,
    journal_paths,
    persist_journal,
    read_journal,
    remove_journals,
)

STAGING_TOKEN_BYTES = 16
STAGING_TOKEN_LENGTH = STAGING_TOKEN_BYTES * 2
ALLOWED_SUFFIXES = {
    "archive": frozenset({".tar", ".tar.zst"}),
    "digest": frozenset({".sha256"}),
}

__all__ = (
    "JOURNAL_NAME",
    "PackageExpectation",
    "PackageJournal",
    "abort_package_transaction",
    "publish_package_outputs",
    "recover_package_transaction",
    "stage_package_file",
    "start_package_transaction",
)


def start_package_transaction(
    path: Path, expected: PackageExpectation
) -> PackageJournal:
    if any(
        candidate.exists() or candidate.is_symlink()
        for candidate in journal_paths(path)
    ):
        raise WorkflowError(f"MCP package output journal already exists: {path}")
    journal = PackageJournal(expected=expected, staged=())
    persist_journal(path, journal)
    return journal


def stage_package_file(
    path: Path,
    journal: PackageJournal,
    output: Path,
    suffix: str,
) -> tuple[PackageJournal, Path]:
    target = output_target(journal.expected, output)
    if suffix not in ALLOWED_SUFFIXES[target]:
        raise WorkflowError(f"unsupported MCP package staging suffix: {suffix}")
    token = secrets.token_hex(STAGING_TOKEN_BYTES)
    temporary = output.parent / f".{output.name}.{token}{suffix}.part"
    intent = StagedFile(temporary, target, suffix)
    with_intent = replace(journal, staged=(*journal.staged, intent))
    persist_journal(path, with_intent)
    try:
        descriptor = os.open(
            temporary,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_CLOEXEC,
            0o600,
        )
        os.close(descriptor)
        identity = temporary.lstat()
        identified = replace(intent, device=identity.st_dev, inode=identity.st_ino)
        updated = replace(
            with_intent,
            staged=(*with_intent.staged[:-1], identified),
        )
        persist_journal(path, updated)
        return updated, temporary
    except OSError as error:
        raise WorkflowError(
            f"cannot stage MCP package beside {output}: {error}"
        ) from error


def publish_package_outputs(
    path: Path,
    journal: PackageJournal,
    archive_temporary: Path,
    digest_temporary: Path,
) -> None:
    archive = output_for_staged(journal, archive_temporary, journal.expected.archive)
    digest = output_for_staged(journal, digest_temporary, journal.expected.digest)
    publishing = replace(journal, archive=archive, digest=digest)
    persist_journal(path, publishing)
    try:
        publish_output(digest)
        publish_output(archive)
        cleanup_error = cleanup_staged(publishing)
        if cleanup_error is not None:
            raise cleanup_error
        remove_journals(path)
    except Exception as error:
        rollback_error = rollback_outputs((archive, digest))
        cleanup_error = cleanup_staged(publishing)
        if rollback_error is None and cleanup_error is None:
            try:
                remove_journals(path)
            except WorkflowError as journal_error:
                cleanup_error = journal_error
        raise_transaction_error(error, rollback_error, cleanup_error)


def publish_output(output: PackageOutput) -> None:
    os.link(output.temporary, output.output)
    fsync_directory(output.output.parent)


def abort_package_transaction(path: Path, expected: PackageExpectation) -> None:
    journal = recovery_journal(path, expected)
    if journal is None:
        return
    validate_journal(journal)
    rollback_journal(path, journal, "abort")


def recover_package_transaction(path: Path, expected: PackageExpectation) -> bool:
    journal = recovery_journal(path, expected)
    if journal is None:
        return False
    validate_journal(journal)
    inspect_owned_paths(journal)
    archive_exists = journal.archive is not None and owned_path_exists(
        journal.archive.output, journal.archive
    )
    digest_exists = journal.digest is not None and owned_path_exists(
        journal.digest.output, journal.digest
    )
    if archive_exists and digest_exists and package_digest_matches(journal):
        cleanup_error = cleanup_staged(journal)
        if cleanup_error is not None:
            raise WorkflowError(
                f"cannot finish recovered MCP package transaction: {cleanup_error}"
            ) from cleanup_error
        remove_journals(path)
        return True
    rollback_journal(path, journal, "recover")
    return False


def recovery_journal(path: Path, expected: PackageExpectation) -> PackageJournal | None:
    existing = [
        candidate
        for candidate in journal_paths(path)
        if candidate.exists() or candidate.is_symlink()
    ]
    if not existing:
        return None
    journals = [read_journal(candidate) for candidate in existing]
    for journal in journals:
        if journal.expected != expected:
            raise WorkflowError(
                "unfinished MCP package transaction does not match requested outputs"
            )
    return journals[-1]


def rollback_journal(path: Path, journal: PackageJournal, action: str) -> None:
    outputs = tuple(
        output for output in (journal.archive, journal.digest) if output is not None
    )
    rollback_error = rollback_outputs(outputs)
    cleanup_error = cleanup_staged(journal)
    if rollback_error is not None or cleanup_error is not None:
        detail = rollback_error if rollback_error is not None else cleanup_error
        raise WorkflowError(
            f"cannot {action} MCP package transaction: {detail}"
        ) from detail
    remove_journals(path)


def inspect_owned_paths(journal: PackageJournal) -> None:
    for staged in journal.staged:
        if staged.identified:
            owned_path_exists(staged.path, staged)
        else:
            inspect_intent_path(staged)
    for output in (journal.archive, journal.digest):
        if output is not None:
            owned_path_exists(output.output, output)


def validate_journal(journal: PackageJournal) -> None:
    targets = {
        "archive": journal.expected.archive,
        "digest": journal.expected.digest,
    }
    if not all(target.is_absolute() for target in targets.values()):
        raise WorkflowError("MCP package output journal contains unsafe paths")
    staged_by_path = {item.path: item for item in journal.staged}
    if len(staged_by_path) != len(journal.staged):
        raise WorkflowError(
            "MCP package output journal contains duplicate staging paths"
        )
    for staged in journal.staged:
        target = targets.get(staged.target)
        if (
            target is None
            or staged.suffix not in ALLOWED_SUFFIXES[staged.target]
            or not safe_staging_path(staged, target)
        ):
            raise WorkflowError("MCP package output journal contains unsafe paths")
    for output in (journal.archive, journal.digest):
        if output is None:
            continue
        staged = staged_by_path.get(output.temporary)
        expected_output = (
            journal.expected.archive
            if output is journal.archive
            else journal.expected.digest
        )
        expected_target = "archive" if output is journal.archive else "digest"
        if (
            output.output != expected_output
            or staged is None
            or not staged.identified
            or staged.target != expected_target
            or (staged.device, staged.inode) != (output.device, output.inode)
        ):
            raise WorkflowError("MCP package output journal contains unsafe outputs")


def safe_staging_path(staged: StagedFile, target: Path) -> bool:
    prefix = f".{target.name}."
    suffix = f"{staged.suffix}.part"
    name = staged.path.name
    if (
        not staged.path.is_absolute()
        or staged.path.parent != target.parent
        or not name.startswith(prefix)
        or not name.endswith(suffix)
    ):
        return False
    token = name[len(prefix) : -len(suffix)]
    return len(token) == STAGING_TOKEN_LENGTH and all(
        character in "0123456789abcdef" for character in token
    )


def output_target(expected: PackageExpectation, output: Path) -> str:
    if output == expected.archive:
        return "archive"
    if output == expected.digest:
        return "digest"
    raise WorkflowError(f"MCP package staging target is not expected: {output}")


def output_for_staged(
    journal: PackageJournal, temporary: Path, output: Path
) -> PackageOutput:
    staged = next((item for item in journal.staged if item.path == temporary), None)
    if staged is None or not staged.identified:
        raise WorkflowError(f"MCP package staging path is not identified: {temporary}")
    assert staged.device is not None and staged.inode is not None
    return PackageOutput(output, temporary, staged.device, staged.inode)


def owned_path_exists(path: Path, identity: StagedFile | PackageOutput) -> bool:
    try:
        actual = path.lstat()
    except FileNotFoundError:
        return False
    except OSError as error:
        raise WorkflowError(
            f"cannot inspect recovered MCP package path: {path}"
        ) from error
    if identity.device is None or identity.inode is None:
        raise WorkflowError(f"MCP package path has no recorded identity: {path}")
    if (actual.st_dev, actual.st_ino) != (identity.device, identity.inode):
        raise WorkflowError(
            f"recovered MCP package path is not owned by the transaction: {path}"
        )
    return True


def inspect_intent_path(staged: StagedFile) -> bool:
    try:
        staged.path.lstat()
    except FileNotFoundError:
        return False
    except OSError as error:
        raise WorkflowError(
            f"cannot inspect MCP package staging intent: {staged.path}"
        ) from error
    raise WorkflowError(
        "MCP package staging intent has no recorded identity; "
        f"preserving unknown path: {staged.path}"
    )


def package_digest_matches(journal: PackageJournal) -> bool:
    assert journal.archive is not None and journal.digest is not None
    try:
        expected = journal.digest.output.read_text(encoding="ascii")
        return expected == sha256(journal.archive.output) + "\n"
    except (OSError, UnicodeDecodeError):
        return False


def rollback_outputs(outputs: tuple[PackageOutput, ...]) -> Exception | None:
    first_error: Exception | None = None
    parents: set[Path] = set()
    for output in reversed(outputs):
        try:
            if remove_identified(output.output, output):
                parents.add(output.output.parent)
        except (OSError, WorkflowError) as error:
            first_error = first_error or error
    return first_error or fsync_directories(parents)


def cleanup_staged(journal: PackageJournal) -> Exception | None:
    first_error: Exception | None = None
    parents: set[Path] = set()
    for staged in journal.staged:
        try:
            removed = (
                remove_identified(staged.path, staged)
                if staged.identified
                else remove_intent(staged)
            )
            if removed:
                parents.add(staged.path.parent)
        except (OSError, WorkflowError) as error:
            first_error = first_error or error
    return first_error or fsync_directories(parents)


def remove_identified(path: Path, identity: StagedFile | PackageOutput) -> bool:
    if not owned_path_exists(path, identity):
        return False
    path.unlink()
    return True


def remove_intent(staged: StagedFile) -> bool:
    if not inspect_intent_path(staged):
        return False
    staged.path.unlink()
    return True


def fsync_directories(paths: set[Path]) -> OSError | None:
    first_error: OSError | None = None
    for path in paths:
        try:
            fsync_directory(path)
        except OSError as error:
            first_error = first_error or error
    return first_error


def raise_transaction_error(
    error: Exception,
    rollback_error: Exception | None,
    cleanup_error: Exception | None,
) -> None:
    if rollback_error is not None or cleanup_error is not None:
        details = "; ".join(
            f"{label} failed: {failure}"
            for label, failure in (
                ("rollback", rollback_error),
                ("cleanup", cleanup_error),
            )
            if failure is not None
        )
        raise WorkflowError(
            f"cannot publish MCP package: {error}; {details}"
        ) from error
    if isinstance(error, WorkflowError):
        raise error
    if isinstance(error, FileExistsError):
        raise WorkflowError("refusing to overwrite MCP package output") from error
    raise WorkflowError(f"cannot publish MCP package: {error}") from error
