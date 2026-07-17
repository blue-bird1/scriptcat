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


@dataclass(frozen=True)
class Upstream:
    source: str
    commit: str
    version: str


@dataclass(frozen=True)
class ChromiumPatch:
    path: PurePosixPath
    sha256: str


@dataclass(frozen=True)
class ProviderLock:
    chromium: Upstream
    depot_tools: Upstream
    chromium_patch: ChromiumPatch
    digest: str


def load_lock(path: Path) -> ProviderLock:
    try:
        raw = path.read_bytes()
        payload = json.loads(raw)
    except FileNotFoundError as error:
        raise WorkflowError(f"browser provider lock is missing: {path}") from error
    except json.JSONDecodeError as error:
        raise WorkflowError(
            f"browser provider lock is invalid JSON: {error}"
        ) from error
    if not isinstance(payload, dict) or set(payload) != {
        "schema_version",
        "chromium",
        "depot_tools",
        "chromium_patch",
    }:
        raise WorkflowError("browser provider lock has an unsupported shape")
    if payload["schema_version"] != 1:
        raise WorkflowError("browser provider lock must have schema_version 1")
    return ProviderLock(
        chromium=_parse_upstream(payload, "chromium"),
        depot_tools=_parse_upstream(payload, "depot_tools"),
        chromium_patch=_parse_patch(payload),
        digest=hashlib.sha256(raw).hexdigest(),
    )


def validate_patch_stack(root: Path, lock: ProviderLock) -> None:
    directory = root.joinpath(*lock.chromium_patch.path.parts)
    series = directory / "series"
    try:
        names = [
            line
            for line in series.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
    except FileNotFoundError as error:
        raise WorkflowError(f"Chromium patch series is missing: {series}") from error
    if not names or len(names) != len(set(names)):
        raise WorkflowError("Chromium patch series is empty or has duplicate entries")
    paths = [directory / name for name in names]
    if any(
        name != name.strip()
        or not name.endswith(".patch")
        or PurePosixPath(name).name != name
        or not path.is_file()
        or path.is_symlink()
        for name, path in zip(names, paths, strict=True)
    ):
        raise WorkflowError("Chromium patch series contains an unsafe entry")
    discovered = {
        path.name
        for path in directory.glob("*.patch")
        if path.is_file() and not path.is_symlink()
    }
    if discovered != set(names):
        raise WorkflowError("Chromium patch series does not cover every patch")
    actual = hashlib.sha256(b"".join(path.read_bytes() for path in paths)).hexdigest()
    if actual != lock.chromium_patch.sha256:
        raise WorkflowError(
            "Chromium patch stack checksum mismatch: "
            f"expected={lock.chromium_patch.sha256} actual={actual}"
        )


def _parse_upstream(payload: dict[str, Any], key: str) -> Upstream:
    value = payload.get(key)
    if not isinstance(value, dict) or set(value) != {"source", "commit", "version"}:
        raise WorkflowError(f"browser provider lock {key} has an unsupported shape")
    source = _require_string(value, "source", key)
    commit = _require_string(value, "commit", key)
    version = _require_string(value, "version", key)
    if not source.startswith(("https://", "ssh://", "git@")):
        raise WorkflowError(f"browser provider lock {key}.source is not a Git URL")
    if not COMMIT_PATTERN.fullmatch(commit):
        raise WorkflowError(f"browser provider lock {key}.commit is not a Git commit")
    return Upstream(source=source, commit=commit, version=version)


def _parse_patch(payload: dict[str, Any]) -> ChromiumPatch:
    value = payload.get("chromium_patch")
    if not isinstance(value, dict) or set(value) != {"path", "sha256"}:
        raise WorkflowError(
            "browser provider lock chromium_patch has an unsupported shape"
        )
    raw_path = _require_string(value, "path", "chromium_patch")
    digest = _require_string(value, "sha256", "chromium_patch")
    path = PurePosixPath(raw_path)
    if path.is_absolute() or ".." in path.parts or not SHA256_PATTERN.fullmatch(digest):
        raise WorkflowError("browser provider lock chromium_patch is unsafe")
    return ChromiumPatch(path=path, sha256=digest)


def _require_string(value: dict[str, Any], key: str, context: str) -> str:
    candidate = value.get(key)
    if not isinstance(candidate, str) or not candidate.strip():
        raise WorkflowError(f"browser provider lock {context}.{key} must be non-empty")
    return candidate.strip()
