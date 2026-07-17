from __future__ import annotations

import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

if __package__.startswith("scripts."):
    from scripts.release_tools.common import (
        LOGGER,
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
        LOGGER,
        WorkflowError,
        cli_main,
        git_output,
        repository_root,
        require_clean_main,
        require_commands,
        run_checked,
        validate_build_id,
    )

__all__ = (
    "LOGGER",
    "RemoteConfig",
    "WorkflowError",
    "assert_local_head",
    "cli_main",
    "git_output",
    "push_main",
    "remote_checked",
    "repository_root",
    "require_clean_main",
    "require_commands",
    "require_wg0",
    "run_checked",
    "run_remote_script",
    "shell_quote",
    "ssh_command",
    "validate_build_id",
)

HEARTBEAT_SECONDS = 60.0


@dataclass(frozen=True)
class RemoteConfig:
    host: str
    checkout: str
    build_root: str


def push_main(root: Path) -> None:
    LOGGER.info("pushing clean main to origin")
    run_checked(("git", "push", "origin", "main"), cwd=root)


def ssh_command(config: RemoteConfig, command: str) -> tuple[str, ...]:
    return ("ssh", "-o", "BatchMode=yes", config.host, command)


def shell_quote(value: object) -> str:
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
    """Run a remote shell program while emitting a local heartbeat."""
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
            LOGGER.info("remote browser build is still running (%ss elapsed)", elapsed)
    if process.returncode:
        raise WorkflowError(
            f"remote browser operation failed with exit status {process.returncode}"
        )
