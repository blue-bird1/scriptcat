from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from ._common import WorkflowError
from ._identity import BUILD_SCHEMA, component_build_id
from ._inventory import Inventory, inspect_runtime
from ._lock import UpstreamLock

MANIFEST_NAME = "build-manifest.json"


@dataclass(frozen=True)
class ComponentManifest:
    build_id: str
    lock_digest: str
    source_date_epoch: int
    versions: dict[str, str]
    provenance: dict[str, dict[str, str]]
    inventory: Inventory


def expected_provenance(lock: UpstreamLock) -> dict[str, dict[str, str]]:
    return {
        "chrome_devtools_mcp": {
            "upstream_commit": lock.mcp.upstream_commit,
            "build_commit": lock.mcp.commit,
        }
    }


def read_component(path: Path, lock: UpstreamLock) -> ComponentManifest:
    manifest_path = path / MANIFEST_NAME
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise WorkflowError(
            f"verified MCP component manifest is invalid: {error}"
        ) from error
    expected_keys = {
        "schema",
        "build_id",
        "lock_digest",
        "source_date_epoch",
        "versions",
        "provenance",
        "files",
        "directories",
    }
    expected_id = component_build_id(lock.digest)
    expected = {
        "schema": BUILD_SCHEMA,
        "build_id": expected_id,
        "lock_digest": lock.digest,
        "versions": {"chrome_devtools_mcp": lock.mcp.version},
        "provenance": expected_provenance(lock),
    }
    if not isinstance(raw, dict) or set(raw) != expected_keys:
        raise WorkflowError("verified MCP component manifest has an unsupported shape")
    if any(raw.get(key) != value for key, value in expected.items()):
        raise WorkflowError("verified MCP component does not match the selected lock")
    epoch = raw.get("source_date_epoch")
    if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch <= 0:
        raise WorkflowError("verified MCP component source date is invalid")
    inventory = inspect_runtime(path / "runtime")
    if raw.get("files") != inventory.files or raw.get("directories") != list(
        inventory.directories
    ):
        raise WorkflowError("verified MCP component runtime differs from its manifest")
    return ComponentManifest(
        build_id=expected_id,
        lock_digest=lock.digest,
        source_date_epoch=epoch,
        versions=expected["versions"],
        provenance=expected["provenance"],
        inventory=inventory,
    )


def materialize_component(
    runtime: Path,
    builds: Path,
    lock: UpstreamLock,
    source_date_epoch: int,
) -> Path:
    inventory = inspect_runtime(runtime)
    build_id = component_build_id(lock.digest)
    manifest = {
        "schema": BUILD_SCHEMA,
        "build_id": build_id,
        "lock_digest": lock.digest,
        "source_date_epoch": source_date_epoch,
        "versions": {"chrome_devtools_mcp": lock.mcp.version},
        "provenance": expected_provenance(lock),
        "files": inventory.files,
        "directories": list(inventory.directories),
    }
    builds.mkdir(parents=True, exist_ok=True)
    final = builds / build_id
    if final.exists() or final.is_symlink():
        read_component(final, lock)
        return final
    temporary = builds / f".{build_id}-new"
    if temporary.exists() or temporary.is_symlink():
        raise WorkflowError(f"component staging path already exists: {temporary}")
    try:
        temporary.mkdir()
        shutil.copytree(runtime, temporary / "runtime", copy_function=shutil.copy2)
        (temporary / MANIFEST_NAME).write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        os.replace(temporary, final)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return final
