#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from mcp._activation import activate_archive
    from mcp._archive import validate_sha256_digest
    from mcp._common import (
        cli_main,
        local_data_root,
        repository_root,
        require_commands,
        validate_build_id,
    )
    from mcp._component import expected_provenance
    from mcp._lock import load_lock
else:
    from ._activation import activate_archive
    from ._archive import validate_sha256_digest
    from ._common import (
        cli_main,
        local_data_root,
        repository_root,
        require_commands,
        validate_build_id,
    )
    from ._component import expected_provenance
    from ._lock import load_lock


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Validate and atomically activate a local MCP archive.",
        epilog=(
            "Verifies the trusted digest, lock, schema-5 manifest, provenance, release "
            "identity, and exact runtime inventory before updating current and "
            "previous. Relative archive, --lock, and --data-root paths resolve from "
            f"the repository root. The default data root is {local_data_root()}; the "
            "command creates its releases directory and atomically updates current and "
            "previous there. The archive is read only and the operation is offline."
            "\n\nExample:\n  uv run --project "
            "scripts --python 3.12 python scripts/mcp/install.py /tmp/mcp.tar.zst "
            "--lock browser/mcp.lock.json "
            "--build-id 0123456789abcdef01234567 --archive-sha256 $archive_sha256"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    result.add_argument(
        "archive", type=Path, metavar="ARCHIVE", help="schema-5 MCP archive to verify"
    )
    result.add_argument(
        "--lock", type=Path, required=True, metavar="PATH", help="MCP supply-chain lock"
    )
    result.add_argument(
        "--archive-sha256",
        required=True,
        metavar="SHA256",
        help="trusted archive digest",
    )
    result.add_argument(
        "--build-id",
        required=True,
        metavar="RELEASE_BUILD_ID",
        help="expected release identity",
    )
    result.add_argument(
        "--data-root",
        type=Path,
        default=local_data_root(),
        metavar="PATH",
        help=f"release and activation store (default: {local_data_root()})",
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    validate_build_id(arguments.build_id, "--build-id")
    validate_sha256_digest(arguments.archive_sha256, "--archive-sha256")
    require_commands("zstd")
    root = repository_root()
    lock_path = arguments.lock.expanduser()
    lock = load_lock(lock_path if lock_path.is_absolute() else root / lock_path)
    data_root = arguments.data_root.expanduser()
    if not data_root.is_absolute():
        data_root = root / data_root
    activated = activate_archive(
        resolve(root, arguments.archive),
        data_root,
        arguments.build_id,
        lock.mcp.version,
        lock.digest,
        expected_archive_sha256=arguments.archive_sha256,
        expected_source_provenance=expected_provenance(lock),
    )
    print(f"activated MCP release {activated}")
    return 0


def resolve(root: Path, path: Path) -> Path:
    expanded = path.expanduser()
    return expanded if expanded.is_absolute() else root / expanded


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
