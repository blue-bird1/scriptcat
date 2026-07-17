from __future__ import annotations

import fcntl
import logging
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

if __package__.startswith("scripts."):
    from scripts.release_tools.common import (
        WorkflowError,
        cli_main,
        git_output,
        repository_root,
        require_clean_main,
        require_commands,
        run_checked,
        validate_build_id,
    )
else:
    from release_tools.common import (
        WorkflowError,
        cli_main,
        git_output,
        repository_root,
        require_clean_main,
        require_commands,
        run_checked,
        validate_build_id,
    )

LOGGER = logging.getLogger("scriptcat.mcp")

__all__ = (
    "LOGGER",
    "WorkflowError",
    "atomic_write",
    "cli_main",
    "exclusive_lock",
    "git_output",
    "local_build_root",
    "local_data_root",
    "repository_root",
    "require_clean_main",
    "require_commands",
    "run_checked",
    "validate_build_id",
)


def local_build_root() -> Path:
    return Path.home() / ".local" / "share" / "scriptcat-mcp-build"


def local_data_root() -> Path:
    return Path.home() / ".local" / "share" / "scriptcat-mcp"


@contextmanager
def exclusive_lock(root: Path, name: str) -> Iterator[None]:
    root.mkdir(parents=True, exist_ok=True)
    path = root / name
    with path.open("a+", encoding="utf-8") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def atomic_write(path: Path, payload: bytes) -> None:
    temporary = path.with_name(f".{path.name}-new")
    if temporary.exists() or temporary.is_symlink():
        raise WorkflowError(f"temporary output already exists: {temporary}")
    try:
        with temporary.open("xb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
