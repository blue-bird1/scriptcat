from __future__ import annotations

import hashlib
import json
from collections.abc import Collection, Mapping

BUILD_SCHEMA = 5
PACKAGE_SCHEMA = 5


def component_build_id(lock_digest: str) -> str:
    source = f"mcp-component-v{BUILD_SCHEMA}\0{lock_digest}".encode()
    return hashlib.sha256(source).hexdigest()[:24]


def release_build_id(
    component_id: str,
    runtime_files: Mapping[str, str],
    runtime_directories: Collection[str],
) -> str:
    inventory = json.dumps(
        {
            "directories": sorted(runtime_directories),
            "files": dict(sorted(runtime_files.items())),
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    source = f"mcp-release-v{PACKAGE_SCHEMA}\0{component_id}\0{inventory}".encode()
    return hashlib.sha256(source).hexdigest()[:24]
