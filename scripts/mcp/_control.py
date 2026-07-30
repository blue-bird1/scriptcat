from __future__ import annotations

import json
import os
import selectors
import subprocess
import time
import tomllib
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from ._activation import ActivationHandoff
from ._common import WorkflowError

SERVER_NAME = "chrome-devtools-scriptcat"
BROKER_ABSENT_MESSAGE = "Shared browser broker is not running."
SHARED_HELP_MARKER = "chrome-devtools-mcp shared"
SHARED_HANDOFF_HELP_MARKER = "chrome-devtools-mcp shared handoff"
MCP_ENTRY_RELATIVE = Path("mcp/bin/chrome-devtools-mcp.js")
CONTROL_TIMEOUT_SECONDS = 30.0
MAX_PROTOCOL_OUTPUT_BYTES = 64 * 1024

ControlAction = Literal["status", "stop"]
SharedAction = Literal["handoff", "status", "stop"]
HandoffDecision = Literal["abort", "commit"]


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
    action: SharedAction,
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
            timeout=CONTROL_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise WorkflowError(
            f"MCP control command timed out after {CONTROL_TIMEOUT_SECONDS:g} seconds"
        ) from error
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


def prepare_broker_release_handoff(
    config_path: Path,
    current_release: Path,
) -> AbstractContextManager[ActivationHandoff | None]:
    manifest = current_release / "manifest.json"
    if not manifest.is_file():
        return nullcontext(None)
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
        return nullcontext(None)

    status_result = run_shared_control(invocation, "status", entry_path=entry)
    if status_result.returncode != 0:
        if BROKER_ABSENT_MESSAGE in f"{status_result.stdout}\n{status_result.stderr}":
            return nullcontext(None)
        raise WorkflowError(
            f"unable to inspect active MCP broker: {result_detail(status_result)}"
        )
    if SHARED_HANDOFF_HELP_MARKER not in help_result.stdout:
        raise WorkflowError(
            "active MCP broker runtime does not support atomic release handoff; "
            "stop it explicitly with scripts/mcp/control.py stop and retry"
        )
    parse_status(status_result.stdout)
    return BrokerReleaseHandoff(invocation, entry)


class BrokerReleaseHandoff(AbstractContextManager[ActivationHandoff]):
    def __init__(
        self,
        invocation: McpInvocation,
        entry_path: Path,
        *,
        timeout_seconds: float = CONTROL_TIMEOUT_SECONDS,
    ) -> None:
        self._invocation = invocation
        self._entry_path = entry_path
        self._timeout_seconds = timeout_seconds
        self._process: subprocess.Popen[bytes] | None = None
        self._stderr_before_ready = b""
        self._decision_sent = False
        self._committed = False

    def __enter__(self) -> BrokerReleaseHandoff:
        command = build_shared_command(
            self._invocation,
            "handoff",
            entry_path=self._entry_path,
        )
        try:
            process = subprocess.Popen(
                command,
                env=os.environ | self._invocation.env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=False,
                bufsize=0,
            )
        except OSError as error:
            raise WorkflowError(
                f"unable to start MCP release handoff: {error}"
            ) from error
        self._process = process
        try:
            line, stderr = read_protocol_line(
                process,
                timeout_seconds=self._timeout_seconds,
            )
            self._stderr_before_ready = stderr
            payload = parse_protocol_object(line, "handoff ready")
            status = payload.get("status")
            if payload.get("state") != "ready" or not isinstance(status, dict):
                raise WorkflowError(
                    "MCP release handoff returned an invalid ready state"
                )
            validate_status(status)
            if (
                status["clientCount"] != 0
                or status["browserCount"] != 0
                or status["handoffActive"] is not True
            ):
                raise WorkflowError(
                    "MCP release handoff became ready in an invalid broker state"
                )
            if stderr.strip():
                raise WorkflowError(
                    f"MCP release handoff wrote unexpected diagnostics: "
                    f"{decode_output(stderr)}"
                )
        except BaseException:
            terminate_process(process)
            raise
        return self

    def commit(self) -> None:
        self._finish("commit")
        self._committed = True

    def __exit__(
        self,
        error_type: type[BaseException] | None,
        error: BaseException | None,
        traceback: object,
    ) -> bool | None:
        del error_type, traceback
        if self._committed:
            return None
        try:
            if not self._decision_sent:
                self._finish("abort")
            else:
                process = self._process
                if process is not None and process.poll() is None:
                    terminate_process(process)
        except BaseException as abort_error:
            if error is None:
                raise
            raise WorkflowError(
                f"activation failed and MCP broker abort failed: {abort_error}"
            ) from error
        return None

    def _finish(self, decision: HandoffDecision) -> None:
        process = self._process
        if process is None or process.stdin is None:
            raise WorkflowError("MCP release handoff is not ready")
        if self._decision_sent:
            raise WorkflowError("MCP release handoff decision was already sent")
        self._decision_sent = True
        try:
            process.stdin.write(f"{decision}\n".encode())
            process.stdin.flush()
            process.stdin.close()
            process.stdin = None
            stdout, stderr = process.communicate(timeout=self._timeout_seconds)
        except subprocess.TimeoutExpired as error:
            terminate_process(process)
            raise WorkflowError(
                f"MCP release handoff {decision} timed out after "
                f"{self._timeout_seconds:g} seconds"
            ) from error
        except OSError as error:
            terminate_process(process)
            raise WorkflowError(
                f"unable to send MCP release handoff {decision}: {error}"
            ) from error
        combined_stderr = self._stderr_before_ready + stderr
        expected_state = "committed" if decision == "commit" else "aborted"
        if process.returncode != 0:
            raise WorkflowError(
                f"MCP release handoff {decision} failed: "
                f"{process_detail(process.returncode, stdout, combined_stderr)}"
            )
        payload = parse_single_protocol_output(stdout, f"handoff {decision}")
        if payload.get("state") != expected_state:
            raise WorkflowError(
                f"MCP release handoff returned an invalid {decision} result"
            )
        if combined_stderr.strip():
            raise WorkflowError(
                f"MCP release handoff {decision} wrote unexpected diagnostics: "
                f"{decode_output(combined_stderr)}"
            )


def read_protocol_line(
    process: subprocess.Popen[bytes],
    *,
    timeout_seconds: float,
) -> tuple[bytes, bytes]:
    if process.stdout is None or process.stderr is None:
        raise WorkflowError("MCP release handoff pipes are unavailable")
    stdout = bytearray()
    stderr = bytearray()
    deadline = time.monotonic() + timeout_seconds
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        while b"\n" not in stdout:
            if not selector.get_map():
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise WorkflowError(
                    f"MCP release handoff ready timed out after "
                    f"{timeout_seconds:g} seconds"
                )
            events = selector.select(remaining)
            if not events:
                if process.poll() is not None:
                    break
                continue
            for key, _ in events:
                stream = key.fileobj
                chunk = os.read(key.fd, 4096)
                if not chunk:
                    selector.unregister(stream)
                    continue
                target = stdout if key.data == "stdout" else stderr
                target.extend(chunk)
                if len(target) > MAX_PROTOCOL_OUTPUT_BYTES:
                    raise WorkflowError("MCP release handoff output exceeded its limit")
        if b"\n" not in stdout:
            raise WorkflowError(
                f"MCP release handoff exited before ready: "
                f"{process_detail(process.poll(), bytes(stdout), bytes(stderr))}"
            )
    line, trailing = bytes(stdout).split(b"\n", 1)
    if trailing.strip():
        raise WorkflowError("MCP release handoff returned unexpected ready output")
    return line, bytes(stderr)


def parse_status(output: str) -> dict[str, object]:
    lines = [line for line in output.splitlines() if line.strip()]
    if len(lines) != 1:
        raise WorkflowError("active MCP broker returned invalid status output")
    payload = parse_protocol_object(lines[0].encode(), "broker status")
    validate_status(payload)
    return payload


def validate_status(payload: dict[str, object]) -> None:
    required = {
        "brokerPid": int,
        "browserCount": int,
        "clientCount": int,
        "configDigest": str,
        "handoffActive": bool,
        "protocolVersion": int,
    }
    if any(
        type(payload.get(key)) is not expected_type
        for key, expected_type in required.items()
    ) or any(
        payload[key] < 0
        for key in ("brokerPid", "browserCount", "clientCount", "protocolVersion")
    ):
        raise WorkflowError("active MCP broker returned an invalid status object")


def parse_single_protocol_output(output: bytes, label: str) -> dict[str, object]:
    lines = [line for line in output.splitlines() if line.strip()]
    if len(lines) != 1:
        raise WorkflowError(f"MCP release {label} returned invalid output")
    return parse_protocol_object(lines[0], label)


def parse_protocol_object(output: bytes, label: str) -> dict[str, object]:
    try:
        payload = json.loads(output)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WorkflowError(f"MCP release {label} returned invalid JSON") from error
    if not isinstance(payload, dict):
        raise WorkflowError(f"MCP release {label} returned a non-object response")
    return payload


def terminate_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        process.kill()
    try:
        process.communicate(timeout=5)
    except subprocess.TimeoutExpired as error:
        raise WorkflowError("unable to terminate MCP release handoff") from error


def process_detail(
    returncode: int | None,
    stdout: bytes,
    stderr: bytes,
) -> str:
    detail = decode_output(stderr).strip() or decode_output(stdout).strip()
    return detail or f"command exited with status {returncode}"


def decode_output(output: bytes) -> str:
    return output.decode("utf-8", errors="replace")


def result_detail(result: ControlResult) -> str:
    detail = result.stderr.strip() or result.stdout.strip()
    return detail or f"command exited with status {result.returncode}"
