from __future__ import annotations

import os
import subprocess
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from ._common import WorkflowError

SERVER_NAME = "chrome-devtools-scriptcat"
BROKER_ABSENT_MESSAGE = "Shared browser broker is not running."
SHARED_HELP_MARKER = "chrome-devtools-mcp shared"
MCP_ENTRY_RELATIVE = Path("mcp/bin/chrome-devtools-mcp.js")

ControlAction = Literal["status", "stop"]


@dataclass(frozen=True)
class McpInvocation:
    command: str
    args: tuple[str, ...]
    env: dict[str, str]
    shared_index: int


@dataclass(frozen=True)
class ControlResult:
    command: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str


def load_mcp_invocation(config_path: Path) -> McpInvocation:
    try:
        with config_path.open("rb") as stream:
            config = tomllib.load(stream)
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise WorkflowError(
            f"MCP config is unavailable or invalid: {config_path}"
        ) from error
    servers = config.get("mcp_servers")
    if not isinstance(servers, dict):
        raise WorkflowError("MCP config has no mcp_servers table")
    server = servers.get(SERVER_NAME)
    if not isinstance(server, dict):
        raise WorkflowError(f"MCP config has no {SERVER_NAME!r} server")
    command = server.get("command")
    raw_args = server.get("args")
    raw_env = server.get("env", {})
    if not isinstance(command, str) or not command:
        raise WorkflowError(f"{SERVER_NAME} command must be a non-empty string")
    if not isinstance(raw_args, list) or not all(
        isinstance(argument, str) for argument in raw_args
    ):
        raise WorkflowError(f"{SERVER_NAME} args must be a list of strings")
    if not isinstance(raw_env, dict) or not all(
        isinstance(key, str) and isinstance(value, str)
        for key, value in raw_env.items()
    ):
        raise WorkflowError(f"{SERVER_NAME} env must contain string values")
    shared_positions = [
        index for index, argument in enumerate(raw_args) if argument == "shared"
    ]
    if len(shared_positions) != 1 or shared_positions[0] == 0:
        raise WorkflowError(
            f"{SERVER_NAME} args must contain one shared subcommand "
            "after its entry path"
        )
    return McpInvocation(
        command=command,
        args=tuple(raw_args),
        env=dict(raw_env),
        shared_index=shared_positions[0],
    )


def build_shared_command(
    invocation: McpInvocation,
    action: ControlAction,
    *,
    force: bool = False,
    entry_path: Path | None = None,
) -> tuple[str, ...]:
    if force and action != "stop":
        raise WorkflowError("--force is only valid for shared stop")
    args = list(invocation.args)
    if entry_path is not None:
        args[invocation.shared_index - 1] = str(entry_path)
    insertion = invocation.shared_index + 1
    args.insert(insertion, action)
    if force:
        args.insert(insertion + 1, "--force")
    return (invocation.command, *args)


def build_shared_help_command(
    invocation: McpInvocation, entry_path: Path
) -> tuple[str, ...]:
    args = list(invocation.args[: invocation.shared_index + 1])
    args[invocation.shared_index - 1] = str(entry_path)
    return (invocation.command, *args, "--help")


def run_control_command(
    invocation: McpInvocation,
    command: tuple[str, ...],
) -> ControlResult:
    try:
        completed = subprocess.run(
            command,
            env=os.environ | invocation.env,
            check=False,
            text=True,
            capture_output=True,
        )
    except OSError as error:
        raise WorkflowError(f"unable to run MCP control command: {error}") from error
    return ControlResult(
        command=command,
        returncode=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )


def run_shared_control(
    invocation: McpInvocation,
    action: ControlAction,
    *,
    force: bool = False,
    entry_path: Path | None = None,
) -> ControlResult:
    return run_control_command(
        invocation,
        build_shared_command(
            invocation,
            action,
            force=force,
            entry_path=entry_path,
        ),
    )


def stop_broker_before_release_switch(
    config_path: Path,
    current_release: Path,
) -> None:
    manifest = current_release / "manifest.json"
    if not manifest.is_file():
        return
    entry = current_release / MCP_ENTRY_RELATIVE
    if not entry.is_file():
        raise WorkflowError(f"active MCP runtime entry is unavailable: {entry}")
    invocation = load_mcp_invocation(config_path)
    help_result = run_control_command(
        invocation,
        build_shared_help_command(invocation, entry),
    )
    if help_result.returncode != 0:
        raise WorkflowError(
            f"unable to inspect active MCP runtime: {result_detail(help_result)}"
        )
    if SHARED_HELP_MARKER not in help_result.stdout:
        return
    stop_result = run_shared_control(invocation, "stop", entry_path=entry)
    if stop_result.returncode == 0:
        return
    if BROKER_ABSENT_MESSAGE in f"{stop_result.stdout}\n{stop_result.stderr}":
        return
    raise WorkflowError(
        f"persistent MCP broker release handoff failed: {result_detail(stop_result)}"
    )


def result_detail(result: ControlResult) -> str:
    detail = result.stderr.strip() or result.stdout.strip()
    return detail or f"command exited with status {result.returncode}"
