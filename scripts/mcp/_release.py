from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from ._archive import (
    CHECKSUMS_NAME,
    MANIFEST_NAME,
    read_manifest,
    sha256,
    verify_manifest,
)
from ._common import WorkflowError
from ._component import ComponentManifest
from ._identity import PACKAGE_SCHEMA, release_build_id


def materialize_release(
    component_path: Path,
    component: ComponentManifest,
    releases: Path,
) -> tuple[Path, str]:
    release_id = release_build_id(
        component.build_id,
        component.inventory.files,
        component.inventory.directories,
    )
    manifest = {
        "schema": PACKAGE_SCHEMA,
        "build_id": release_id,
        "component_build_id": component.build_id,
        "lock_digest": component.lock_digest,
        "versions": component.versions,
        "provenance": component.provenance,
        "files": component.inventory.files,
        "directories": list(component.inventory.directories),
    }
    releases.mkdir(parents=True, exist_ok=True)
    final = releases / f"release-{release_id}"
    if final.exists() or final.is_symlink():
        if final.is_symlink() or not final.is_dir():
            raise WorkflowError(f"cached MCP release path is invalid: {final}")
        installed = read_manifest(final)
        verify_manifest(final, installed)
        if (
            installed.build_id != release_id
            or installed.component_build_id != component.build_id
            or installed.lock_digest != component.lock_digest
            or installed.versions != component.versions
            or installed.provenance != component.provenance
            or installed.files != component.inventory.files
            or installed.directories != component.inventory.directories
        ):
            raise WorkflowError(
                "cached MCP release differs from the requested component"
            )
        return final, release_id
    temporary_parent = releases / f".release-{release_id}-new"
    temporary = temporary_parent / f"release-{release_id}"
    if temporary_parent.exists() or temporary_parent.is_symlink():
        raise WorkflowError(f"release staging path already exists: {temporary_parent}")
    try:
        shutil.copytree(
            component_path / "runtime", temporary, copy_function=shutil.copy2
        )
        (temporary / MANIFEST_NAME).write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        (temporary / CHECKSUMS_NAME).write_bytes(
            checksum_payload(temporary, component.inventory.files)
        )
        verify_manifest(temporary, read_manifest(temporary))
        os.replace(temporary, final)
        temporary_parent.rmdir()
    except BaseException:
        shutil.rmtree(temporary_parent, ignore_errors=True)
        raise
    return final, release_id


def checksum_payload(root: Path, files: dict[str, str]) -> bytes:
    records = []
    for relative in sorted([*files, MANIFEST_NAME]):
        records.append(f"{sha256(root / relative)}  {relative}".encode() + b"\0")
    return b"".join(records)
