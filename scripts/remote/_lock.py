from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from ._common import WorkflowError

COMMIT_PATTERN = re.compile(r"[0-9a-f]{40}")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
TARGETS = frozenset({"chromium", "chrome-devtools-mcp", "scriptcat"})


@dataclass(frozen=True)
class Upstream:
    name: str
    source: str
    commit: str
    version: str


@dataclass(frozen=True)
class PatchStack:
    target: str
    path: PurePosixPath
    sha256: str


@dataclass(frozen=True)
class UpstreamLock:
    depot_tools: Upstream
    chromium: Upstream
    mcp: Upstream
    scriptcat: Upstream
    patch_stacks: tuple[PatchStack, ...]
    digest: str


def load_lock(path: Path) -> UpstreamLock:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise WorkflowError(f"upstream lock is missing: {path}") from error
    except json.JSONDecodeError as error:
        raise WorkflowError(f"upstream lock is invalid JSON: {error}") from error
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise WorkflowError("upstream lock must have schema_version 1")
    depot_tools = parse_upstream(payload, "depot_tools")
    chromium = parse_upstream(payload, "chromium")
    mcp = parse_upstream(payload, "chrome_devtools_mcp")
    scriptcat = parse_upstream(payload, "scriptcat")
    stacks = parse_patch_stacks(payload)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return UpstreamLock(depot_tools, chromium, mcp, scriptcat, stacks, digest)


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
        for path in paths:
            digest.update(path.read_bytes())
        actual = digest.hexdigest()
        if actual != stack.sha256:
            raise WorkflowError(
                "patch stack checksum mismatch: "
                f"target={stack.target} expected={stack.sha256} actual={actual}"
            )


def parse_upstream(payload: dict[str, Any], key: str) -> Upstream:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise WorkflowError(f"upstream lock key {key!r} must be an object")
    source = require_string(value, "source", key)
    commit = require_string(value, "commit", key)
    version = require_string(value, "version", key)
    if not COMMIT_PATTERN.fullmatch(commit):
        raise WorkflowError(f"{key}.commit must be a lowercase 40-hex Git commit")
    if not source.startswith(("https://", "ssh://", "git@")):
        raise WorkflowError(f"{key}.source must be an explicit Git URL")
    return Upstream(key, source, commit, version)


def parse_patch_stacks(payload: dict[str, Any]) -> tuple[PatchStack, ...]:
    values = payload.get("patch_stacks")
    if not isinstance(values, list) or len(values) != 3:
        raise WorkflowError("patch_stacks must contain exactly three patch stacks")
    stacks: list[PatchStack] = []
    for value in values:
        if not isinstance(value, dict):
            raise WorkflowError("each patch stack must be an object")
        target = require_string(value, "target", "patch stack")
        raw_path = require_string(value, "path", "patch stack")
        sha256 = require_string(value, "sha256", "patch stack")
        path = PurePosixPath(raw_path)
        if target not in TARGETS or path.is_absolute() or ".." in path.parts:
            raise WorkflowError("patch stack target/path is unsafe or unsupported")
        if not SHA256_PATTERN.fullmatch(sha256):
            raise WorkflowError("patch stack sha256 must be lowercase 64-hex")
        stacks.append(PatchStack(target, path, sha256))
    if {stack.target for stack in stacks} != TARGETS:
        raise WorkflowError("patch_stacks must contain one stack for every upstream")
    return tuple(stacks)


def require_string(value: dict[str, Any], key: str, context: str) -> str:
    candidate = value.get(key)
    if not isinstance(candidate, str) or not candidate.strip():
        raise WorkflowError(f"{context}.{key} must be a non-empty string")
    return candidate.strip()
