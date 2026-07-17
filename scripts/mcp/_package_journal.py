from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path

from ._common import WorkflowError

JOURNAL_NAME = ".package-output-journal.json"
JOURNAL_SCHEMA = 2


@dataclass(frozen=True)
class StagedFile:
    path: Path
    target: str
    suffix: str
    device: int | None = None
    inode: int | None = None

    @property
    def identified(self) -> bool:
        return self.device is not None and self.inode is not None


@dataclass(frozen=True)
class PackageOutput:
    output: Path
    temporary: Path
    device: int
    inode: int


@dataclass(frozen=True)
class PackageExpectation:
    component_build_id: str
    release_build_id: str
    archive: Path
    digest: Path


@dataclass(frozen=True)
class PackageJournal:
    expected: PackageExpectation
    staged: tuple[StagedFile, ...]
    archive: PackageOutput | None = None
    digest: PackageOutput | None = None


def persist_journal(path: Path, journal: PackageJournal) -> None:
    temporary = journal_temporary(path)
    if temporary.exists() or temporary.is_symlink():
        raise WorkflowError(
            f"MCP package journal staging path already exists: {temporary}"
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
            f"cannot persist MCP package output journal: {error}"
        ) from error


def read_journal(path: Path) -> PackageJournal:
    try:
        identity = path.lstat()
        if not stat.S_ISLNK(identity.st_mode):
            raise WorkflowError(f"MCP package output journal is not a symlink: {path}")
        raw = json.loads(os.readlink(path))
    except WorkflowError:
        raise
    except (OSError, json.JSONDecodeError) as error:
        raise WorkflowError(
            f"MCP package output journal is invalid: {error}"
        ) from error
    expected_keys = {
        "schema",
        "component_build_id",
        "release_build_id",
        "archive_target",
        "digest_target",
        "staged",
        "archive",
        "digest",
    }
    if (
        not isinstance(raw, dict)
        or set(raw) != expected_keys
        or raw["schema"] != JOURNAL_SCHEMA
    ):
        raise WorkflowError("MCP package output journal has an unsupported shape")
    expected = PackageExpectation(
        component_build_id=require_string(raw, "component_build_id"),
        release_build_id=require_string(raw, "release_build_id"),
        archive=require_path(raw, "archive_target"),
        digest=require_path(raw, "digest_target"),
    )
    staged_raw = raw["staged"]
    if not isinstance(staged_raw, list):
        raise WorkflowError("MCP package output journal has an unsupported shape")
    archive = parse_output(raw["archive"])
    digest = parse_output(raw["digest"])
    if (archive is None) != (digest is None):
        raise WorkflowError("MCP package output journal has an unsupported shape")
    return PackageJournal(
        expected=expected,
        staged=tuple(parse_staged(item) for item in staged_raw),
        archive=archive,
        digest=digest,
    )


def journal_payload(journal: PackageJournal) -> dict[str, object]:
    return {
        "schema": JOURNAL_SCHEMA,
        "component_build_id": journal.expected.component_build_id,
        "release_build_id": journal.expected.release_build_id,
        "archive_target": str(journal.expected.archive),
        "digest_target": str(journal.expected.digest),
        "staged": [staged_payload(item) for item in journal.staged],
        "archive": output_payload(journal.archive),
        "digest": output_payload(journal.digest),
    }


def staged_payload(staged: StagedFile) -> dict[str, object]:
    return {
        "path": str(staged.path),
        "target": staged.target,
        "suffix": staged.suffix,
        "device": staged.device,
        "inode": staged.inode,
    }


def output_payload(output: PackageOutput | None) -> dict[str, object] | None:
    if output is None:
        return None
    return {
        "output": str(output.output),
        "temporary": str(output.temporary),
        "device": output.device,
        "inode": output.inode,
    }


def parse_staged(raw: object) -> StagedFile:
    if not isinstance(raw, dict) or set(raw) != {
        "path",
        "target",
        "suffix",
        "device",
        "inode",
    }:
        raise WorkflowError("MCP package output journal has an unsupported shape")
    target = require_string(raw, "target")
    suffix = require_string(raw, "suffix")
    device = optional_identity(raw["device"])
    inode = optional_identity(raw["inode"])
    if (device is None) != (inode is None) or inode == 0:
        raise WorkflowError("MCP package output journal has an unsupported shape")
    return StagedFile(require_path(raw, "path"), target, suffix, device, inode)


def parse_output(raw: object) -> PackageOutput | None:
    if raw is None:
        return None
    if not isinstance(raw, dict) or set(raw) != {
        "output",
        "temporary",
        "device",
        "inode",
    }:
        raise WorkflowError("MCP package output journal has an unsupported shape")
    device = require_identity(raw["device"])
    inode = require_identity(raw["inode"])
    if inode == 0:
        raise WorkflowError("MCP package output journal has an unsupported shape")
    return PackageOutput(
        require_path(raw, "output"),
        require_path(raw, "temporary"),
        device,
        inode,
    )


def optional_identity(value: object) -> int | None:
    if value is None:
        return None
    return require_identity(value)


def require_identity(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise WorkflowError("MCP package output journal has an unsupported shape")
    return value


def require_string(raw: dict[object, object], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value:
        raise WorkflowError("MCP package output journal has an unsupported shape")
    return value


def require_path(raw: dict[object, object], key: str) -> Path:
    return Path(require_string(raw, key))


def journal_paths(path: Path) -> tuple[Path, Path]:
    return path, journal_temporary(path)


def journal_temporary(path: Path) -> Path:
    return path.with_name(f"{path.name}.new")


def remove_journals(path: Path) -> None:
    try:
        removed = False
        for candidate in journal_paths(path):
            if candidate.exists() or candidate.is_symlink():
                if not stat.S_ISLNK(candidate.lstat().st_mode):
                    raise WorkflowError(
                        f"refusing to remove non-journal path: {candidate}"
                    )
                candidate.unlink()
                removed = True
        if removed:
            fsync_directory(path.parent)
    except OSError as error:
        raise WorkflowError(
            f"cannot remove MCP package output journal: {error}"
        ) from error


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
