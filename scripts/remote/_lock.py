from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from ._common import WorkflowError, git_output, run_checked

COMMIT_PATTERN = re.compile(r"[0-9a-f]{40}")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
MCP_SUBMODULE_PATH = PurePosixPath("browser/chrome-devtools-mcp")
LOCK_KEYS = frozenset(
    {"schema_version", "chrome_devtools_mcp", "scriptcat", "patch_stacks"}
)


@dataclass(frozen=True)
class Upstream:
    name: str
    source: str
    commit: str
    version: str


@dataclass(frozen=True)
class McpUpstream(Upstream):
    upstream_source: str
    upstream_commit: str

    @property
    def submodule_path(self) -> PurePosixPath:
        return MCP_SUBMODULE_PATH


@dataclass(frozen=True)
class PatchStack:
    target: str
    path: PurePosixPath
    sha256: str


@dataclass(frozen=True)
class UpstreamLock:
    mcp: McpUpstream
    scriptcat: Upstream
    patch_stacks: tuple[PatchStack, ...]
    digest: str

    def patch_digest(self, target: str) -> str:
        for stack in self.patch_stacks:
            if stack.target == target:
                return stack.sha256
        raise WorkflowError(f"MCP lock has no patch stack for {target}")


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
        or payload.get("schema_version") != 1
    ):
        raise WorkflowError("MCP lock must use the exact schema_version 1 shape")
    return UpstreamLock(
        mcp=parse_mcp_upstream(payload),
        scriptcat=parse_upstream(payload, "scriptcat"),
        patch_stacks=parse_patch_stacks(payload),
        digest=hashlib.sha256(raw).hexdigest(),
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
        ("git", "submodule", "status", "--recursive"), cwd=root, capture=True
    ).stdout.rstrip()
    status_lines = [line for line in status.splitlines() if line]
    expected_status = f" {lock.mcp.commit} {MCP_SUBMODULE_PATH.as_posix()}"
    if not any(line.startswith(expected_status) for line in status_lines):
        unsafe = [line for line in status_lines if line.startswith(("-", "+", "U"))]
        if unsafe:
            raise WorkflowError(
                "MCP submodule status is uninitialized, mismatched, or conflicted: "
                f"{unsafe[0]}"
            )
        raise WorkflowError(
            "MCP submodule status does not match the checked-out gitlink"
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


def validate_patch_stacks(root: Path, lock: UpstreamLock) -> None:
    for stack in lock.patch_stacks:
        directory = root / stack.path
        series = directory / "series"
        try:
            lines = series.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError as error:
            raise WorkflowError(f"patch series is missing: {series}") from error
        names = [
            line for line in lines if line.strip() and not line.lstrip().startswith("#")
        ]
        if not names:
            raise WorkflowError(f"patch series is empty: {series}")
        if any(name != name.strip() for name in names):
            raise WorkflowError(
                f"patch series contains surrounding whitespace: {series}"
            )
        if len(names) != len(set(names)):
            raise WorkflowError(f"patch series contains duplicate entries: {series}")
        paths = [directory / name for name in names]
        if any(
            not name.endswith(".patch")
            or PurePosixPath(name).name != name
            or not path.is_file()
            or path.is_symlink()
            for name, path in zip(names, paths, strict=True)
        ):
            raise WorkflowError(f"patch series contains an unsafe entry: {series}")
        discovered = {
            path.name
            for path in directory.glob("*.patch")
            if path.is_file() and not path.is_symlink()
        }
        if discovered != set(names):
            raise WorkflowError(
                f"patch series does not cover exactly every patch: {series}"
            )
        digest = hashlib.sha256()
        for patch in paths:
            digest.update(patch.read_bytes())
        actual = digest.hexdigest()
        if actual != stack.sha256:
            raise WorkflowError(
                "patch stack checksum mismatch: "
                f"target={stack.target} expected={stack.sha256} actual={actual}"
            )


def parse_upstream(payload: dict[str, Any], key: str) -> Upstream:
    value = require_object(payload, key, "MCP lock")
    if set(value) != {"version", "commit", "source"}:
        raise WorkflowError(f"MCP lock key {key!r} has an unsupported shape")
    return Upstream(
        name=key,
        source=parse_source(value, "source", key),
        commit=parse_commit(value, "commit", key),
        version=require_string(value, "version", key),
    )


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
        name=key,
        source=parse_source(value, "source", key),
        commit=parse_commit(value, "commit", key),
        version=require_string(value, "version", key),
        upstream_source=parse_source(value, "upstream_source", key),
        upstream_commit=parse_commit(value, "upstream_commit", key),
    )


def parse_patch_stacks(payload: dict[str, Any]) -> tuple[PatchStack, ...]:
    values = payload.get("patch_stacks")
    if not isinstance(values, list) or len(values) != 1:
        raise WorkflowError("patch_stacks must contain exactly the ScriptCat stack")
    value = values[0]
    if not isinstance(value, dict) or set(value) != {"target", "path", "sha256"}:
        raise WorkflowError("ScriptCat patch stack has an unsupported shape")
    target = require_string(value, "target", "patch stack")
    raw_path = require_string(value, "path", "patch stack")
    sha256 = require_string(value, "sha256", "patch stack")
    path = PurePosixPath(raw_path)
    if target != "scriptcat" or path.is_absolute() or ".." in path.parts:
        raise WorkflowError("patch stack target/path is unsafe or unsupported")
    if not SHA256_PATTERN.fullmatch(sha256):
        raise WorkflowError("patch stack sha256 must be lowercase 64-hex")
    return (PatchStack(target=target, path=path, sha256=sha256),)


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
