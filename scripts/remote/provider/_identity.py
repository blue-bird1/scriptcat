from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping

BUILD_SCHEMA = 2
PACKAGE_SCHEMA = 2


def component_build_id(lock_digest: str) -> str:
    """Return the provider component identity for one pinned browser input set."""
    source = f"provider-component-v{BUILD_SCHEMA}\0{lock_digest}".encode()
    return hashlib.sha256(source).hexdigest()[:24]


def release_build_id(component_id: str, runtime_files: Mapping[str, str]) -> str:
    """Return the provider release identity for one verified runtime inventory."""
    serialized_files = json.dumps(
        dict(sorted(runtime_files.items())), separators=(",", ":"), sort_keys=True
    )
    source = (
        f"provider-release-v{PACKAGE_SCHEMA}\0{component_id}\0{serialized_files}"
    ).encode()
    return hashlib.sha256(source).hexdigest()[:24]
