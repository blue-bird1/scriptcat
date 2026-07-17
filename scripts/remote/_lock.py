from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from ._common import WorkflowError, git_output, run_checked

COMMIT_PATTERN = re.compile(r"[0-9a-f]{40}")
MCP_SUBMODULE_PATH = PurePosixPath("browser/chrome-devtools-mcp")
LOCK_KEYS = frozenset({"schema_version", "chrome_devtools_mcp"})


@dataclass(frozen=True)
class McpUpstream:
    source: str
    commit: str
    version: str
    upstream_source: str
    upstream_commit: str

    @property
    def submodule_path(self) -> PurePosixPath:
        return MCP_SUBMODULE_PATH


@dataclass(frozen=True)
class UpstreamLock:
    mcp: McpUpstream
    digest: str


def load_lock(path: Path) -> UpstreamLock:
    try:
        raw = path.read_bytes()
        payload = json.loads(raw)
    except FileNotFoundError as error:
        raise WorkflowError(f"MCP lock is missing: {path}") from error
    except json.JSONDecodeError as error:
        raise WorkflowError(f"MCP lock is invalid JSON: {error}") from error
    if (
        not isinstance(payload, dict)
        or set(payload) != LOCK_KEYS
        or payload.get("schema_version") != 2
    ):
        raise WorkflowError("MCP lock must use the exact schema_version 2 shape")
    return UpstreamLock(
        mcp=parse_mcp_upstream(payload), digest=hashlib.sha256(raw).hexdigest()
    )


def validate_mcp_submodule(root: Path, lock: UpstreamLock) -> None:
    """Require the checked-out MCP submodule to match the selected lock."""
    modules = root / ".gitmodules"
    if not modules.is_file() or modules.is_symlink():
        raise WorkflowError(f"MCP submodule metadata is missing: {modules}")
    entries = parse_gitmodules(root, modules)
    matching = [
        name for name, path in entries.items() if path == MCP_SUBMODULE_PATH.as_posix()
    ]
    if len(matching) != 1:
        raise WorkflowError(
            "MCP submodule metadata must declare exactly one path: "
            f"{MCP_SUBMODULE_PATH.as_posix()}"
        )
    source = git_output(
        root, "config", "--file", str(modules), "--get", f"submodule.{matching[0]}.url"
    )
    if source != lock.mcp.source:
        raise WorkflowError(
            "MCP submodule URL does not match chrome_devtools_mcp.source"
        )
    gitlink = git_output(root, "ls-tree", "HEAD", "--", MCP_SUBMODULE_PATH.as_posix())
    expected_gitlink = (
        f"160000 commit {lock.mcp.commit}\t{MCP_SUBMODULE_PATH.as_posix()}"
    )
    if gitlink != expected_gitlink:
        raise WorkflowError(
            "MCP submodule gitlink does not match chrome_devtools_mcp.commit"
        )
    status = run_checked(
        ("git", "submodule", "status", "--", MCP_SUBMODULE_PATH.as_posix()),
        cwd=root,
        capture=True,
    ).stdout.rstrip()
    expected_status = f" {lock.mcp.commit} {MCP_SUBMODULE_PATH.as_posix()}"
    if not status.startswith(expected_status):
        raise WorkflowError(
            "MCP submodule status is uninitialized, mismatched, or conflicted"
        )
    checkout = root / MCP_SUBMODULE_PATH
    if not checkout.is_dir() or checkout.is_symlink():
        raise WorkflowError(f"MCP submodule checkout is unavailable: {checkout}")
    if git_output(checkout, "rev-parse", "HEAD") != lock.mcp.commit:
        raise WorkflowError(
            "MCP submodule HEAD does not match chrome_devtools_mcp.commit"
        )
    if git_output(checkout, "status", "--porcelain"):
        raise WorkflowError("MCP submodule checkout is dirty")
    try:
        git_output(
            checkout, "merge-base", "--is-ancestor", lock.mcp.upstream_commit, "HEAD"
        )
    except WorkflowError as error:
        raise WorkflowError(
            "MCP custom commit is not a descendant of "
            "chrome_devtools_mcp.upstream_commit"
        ) from error


def parse_gitmodules(root: Path, modules: Path) -> dict[str, str]:
    output = git_output(
        root, "config", "--file", str(modules), "--get-regexp", r"^submodule\..*\.path$"
    )
    entries: dict[str, str] = {}
    for line in output.splitlines():
        key, separator, value = line.partition(" ")
        if (
            not separator
            or not key.startswith("submodule.")
            or not key.endswith(".path")
        ):
            raise WorkflowError("MCP submodule metadata is malformed")
        name = key.removeprefix("submodule.").removesuffix(".path")
        if not name or name in entries:
            raise WorkflowError("MCP submodule metadata is malformed")
        entries[name] = value
    return entries


def parse_mcp_upstream(payload: dict[str, Any]) -> McpUpstream:
    key = "chrome_devtools_mcp"
    value = require_object(payload, key, "MCP lock")
    if set(value) != {
        "version",
        "commit",
        "source",
        "upstream_source",
        "upstream_commit",
    }:
        raise WorkflowError(f"MCP lock key {key!r} has an unsupported shape")
    return McpUpstream(
        source=parse_source(value, "source", key),
        commit=parse_commit(value, "commit", key),
        version=require_string(value, "version", key),
        upstream_source=parse_source(value, "upstream_source", key),
        upstream_commit=parse_commit(value, "upstream_commit", key),
    )


def require_object(payload: dict[str, Any], key: str, context: str) -> dict[str, Any]:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise WorkflowError(f"{context} key {key!r} must be an object")
    return value


def parse_source(value: dict[str, Any], key: str, context: str) -> str:
    source = require_string(value, key, context)
    if not source.startswith(("https://", "ssh://", "git@")):
        raise WorkflowError(f"{context}.{key} must be an explicit Git URL")
    return source


def parse_commit(value: dict[str, Any], key: str, context: str) -> str:
    commit = require_string(value, key, context)
    if not COMMIT_PATTERN.fullmatch(commit):
        raise WorkflowError(f"{context}.{key} must be a lowercase 40-hex Git commit")
    return commit


def require_string(value: dict[str, Any], key: str, context: str) -> str:
    candidate = value.get(key)
    if not isinstance(candidate, str) or not candidate.strip():
        raise WorkflowError(f"{context}.{key} must be a non-empty string")
    return candidate.strip()
