#!/usr/bin/env -S uv run python
from __future__ import annotations

import logging
import os
import shlex
import shutil
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

LOGGER = logging.getLogger("scriptcat.remote")
REMOTE_HOST = "root@192.168.50.8"
REMOTE_CHECKOUT = "/root/scriptcat"
REMOTE_BUILD_ROOT = "/root/scriptcat-mcp-build"
HEARTBEAT_SECONDS = 60.0
EXTENSION_BASE = Path.home() / ".codex" / "chrome-extensions" / "scriptcat"


@dataclass(frozen=True)
class RemoteConfig:
    host: str = REMOTE_HOST
    checkout: str = REMOTE_CHECKOUT
    build_root: str = REMOTE_BUILD_ROOT


class WorkflowError(RuntimeError):
    """An expected, actionable workflow failure."""


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
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() if error.stderr else "command failed"
        raise WorkflowError(f"{shlex.join(command)}: {detail}") from error


def git_output(root: Path, *arguments: str) -> str:
    return run_checked(("git", *arguments), cwd=root, capture=True).stdout.strip()


def require_clean_main(root: Path) -> str:
    branch = git_output(root, "branch", "--show-current")
    if branch != "main":
        raise WorkflowError(f"current branch is {branch!r}; expected 'main'")
    if git_output(root, "status", "--porcelain"):
        raise WorkflowError(
            "local checkout is dirty; commit before a remote release stage"
        )
    return git_output(root, "rev-parse", "HEAD")


def push_main(root: Path) -> None:
    LOGGER.info("pushing clean main to origin")
    run_checked(("git", "push", "origin", "main"), cwd=root)


def ssh_command(config: RemoteConfig, command: str) -> tuple[str, ...]:
    return ("ssh", "-o", "BatchMode=yes", config.host, command)


def shell_quote(value: str | Path) -> str:
    return shlex.quote(str(value))


def remote_checked(
    config: RemoteConfig, command: str, *, capture: bool = False
) -> subprocess.CompletedProcess[str]:
    return run_checked(ssh_command(config, command), capture=capture)


def require_wg0() -> None:
    completed = run_checked(("ip", "-o", "link", "show", "dev", "wg0"), capture=True)
    if "wg0" not in completed.stdout:
        raise WorkflowError(
            "wg0 is unavailable; connect the build-server WireGuard tunnel"
        )


def assert_local_head(root: Path, expected: str) -> None:
    current = git_output(root, "rev-parse", "HEAD")
    if current != expected:
        raise WorkflowError("local HEAD changed while the remote build was running")
    if git_output(root, "status", "--porcelain"):
        raise WorkflowError(
            "local checkout became dirty while the remote build was running"
        )


def run_remote_script(config: RemoteConfig, script: str) -> None:
    """Run a remote shell program while emitting a local 60-second heartbeat."""
    process = subprocess.Popen(
        (*ssh_command(config, "bash -s"),),
        stdin=subprocess.PIPE,
        stdout=sys.stderr,
        stderr=sys.stderr,
        text=True,
    )
    assert process.stdin is not None
    process.stdin.write(script)
    process.stdin.close()
    started = time.monotonic()
    while process.poll() is None:
        try:
            process.wait(timeout=HEARTBEAT_SECONDS)
        except subprocess.TimeoutExpired:
            elapsed = int(time.monotonic() - started)
            LOGGER.info("remote build is still running (%ss elapsed)", elapsed)
    if process.returncode:
        raise WorkflowError(
            f"remote build failed with exit status {process.returncode}"
        )


def local_data_root() -> Path:
    return Path.home() / ".local" / "share" / "scriptcat-mcp"


def extension_root(scriptcat_version: str) -> Path:
    version_path = PurePosixPath(scriptcat_version)
    if (
        version_path.is_absolute()
        or len(version_path.parts) != 1
        or version_path.name != scriptcat_version
        or scriptcat_version in {".", ".."}
    ):
        raise WorkflowError("scriptcat.version is unsafe for an extension path")
    return EXTENSION_BASE / scriptcat_version


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


def environment_value(name: str, default: str) -> str:
    value = os.environ.get(name, default).strip()
    if not value:
        raise WorkflowError(f"{name} must not be empty")
    return value
