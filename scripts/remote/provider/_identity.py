from __future__ import annotations

import hashlib
import json
from collections.abc import Collection, Mapping

BUILD_SCHEMA = 2
PACKAGE_SCHEMA = 2
RELEASE_GN_ARGS = (
    "is_debug=false",
    "dcheck_always_on=false",
    "is_component_build=false",
    "symbol_level=0",
    "blink_symbol_level=0",
    "v8_symbol_level=0",
    "use_remoteexec=false",
    "use_siso=false",
)


def component_build_id(lock_digest: str) -> str:
    """Return the provider component identity for one pinned browser input set."""
    recipe = " ".join(RELEASE_GN_ARGS)
    source = f"provider-component-v{BUILD_SCHEMA}\0{lock_digest}\0{recipe}".encode()
    return hashlib.sha256(source).hexdigest()[:24]


def legacy_component_build_id(lock_digest: str, project_commit: str) -> str:
    """Return the schema-1 provider component identity for migration only."""
    return hashlib.sha256(f"{lock_digest}{project_commit}".encode()).hexdigest()[:24]


def release_build_id(
    component_id: str,
    runtime_files: Mapping[str, str],
    runtime_directories: Collection[str],
) -> str:
    """Return the provider release identity for one verified runtime inventory."""
    serialized_inventory = json.dumps(
        {
            "directories": sorted(runtime_directories),
            "files": dict(sorted(runtime_files.items())),
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    source = (
        f"provider-release-v{PACKAGE_SCHEMA}\0{component_id}\0{serialized_inventory}"
    ).encode()
    return hashlib.sha256(source).hexdigest()[:24]
