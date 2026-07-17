from __future__ import annotations

import logging
import shlex
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

LOGGER = logging.getLogger("scriptcat.release")


class WorkflowError(RuntimeError):
    """An expected, actionable release workflow failure."""


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")


def repository_root() -> Path:
    completed = run_checked(("git", "rev-parse", "--show-toplevel"), capture=True)
    return Path(completed.stdout.strip())


def require_commands(*commands: str) -> None:
    missing = [command for command in commands if shutil.which(command) is None]
    if missing:
        raise WorkflowError(f"required commands are unavailable: {', '.join(missing)}")


def run_checked(
    command: Sequence[str], *, cwd: Path | None = None, capture: bool = False
) -> subprocess.CompletedProcess[str]:
    LOGGER.debug("running: %s", shlex.join(command))
    try:
        return subprocess.run(
            command,
            cwd=cwd,
            check=True,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        if isinstance(error, subprocess.CalledProcessError):
            detail = error.stderr.strip() if error.stderr else "command failed"
        else:
            detail = str(error)
        raise WorkflowError(f"{shlex.join(command)}: {detail}") from error


def git_output(root: Path, *arguments: str) -> str:
    return run_checked(("git", *arguments), cwd=root, capture=True).stdout.strip()


def require_clean_main(root: Path) -> str:
    branch = git_output(root, "branch", "--show-current")
    if branch != "main":
        raise WorkflowError(f"current branch is {branch!r}; expected 'main'")
    if git_output(root, "status", "--porcelain"):
        raise WorkflowError("local checkout is dirty; commit before a release stage")
    return git_output(root, "rev-parse", "HEAD")


def validate_build_id(value: str, label: str) -> None:
    is_lowercase_hex = all(character in "0123456789abcdef" for character in value)
    if len(value) != 24 or not is_lowercase_hex:
        raise WorkflowError(
            f"{label} must be exactly 24 lowercase hexadecimal characters"
        )


def cli_main(
    main: Callable[[Sequence[str]], int], argv: Sequence[str] | None = None
) -> int:
    configure_logging()
    try:
        return int(main(argv if argv is not None else sys.argv[1:]))
    except WorkflowError as error:
        LOGGER.error("%s", error)
        return 1
    except KeyboardInterrupt:
        LOGGER.error("interrupted")
        return 130
