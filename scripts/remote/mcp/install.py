#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from remote._activation import activate_archive
    from remote._archive import validate_sha256_digest
    from remote._common import (
        cli_main,
        extension_root,
        local_data_root,
        require_commands,
        validate_build_id,
    )
    from remote._lock import UpstreamLock, load_lock
else:
    from .._activation import activate_archive
    from .._archive import validate_sha256_digest
    from .._common import (
        cli_main,
        extension_root,
        local_data_root,
        require_commands,
        validate_build_id,
    )
    from .._lock import UpstreamLock, load_lock


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Validate and atomically activate an MCP/ScriptCat archive.",
        epilog=(
            "Verifies the trusted archive digest, selected MCP lock, manifest, and "
            "runtime inventory before activating under ~/.local/share/scriptcat-mcp. "
            "The operation is offline, preserves the fixed profile, deploys the "
            "physical managed ScriptCat extension transactionally, and does not "
            "access another product.\n\nExample:\n"
            "  set archive_sha256 (string trim < /tmp/mcp.tar.zst.sha256)\n"
            "  uv run --project scripts --python 3.12 python "
            "scripts/remote/mcp/install.py /tmp/mcp.tar.zst "
            "--lock browser/mcp.lock.json --build-id 0123456789abcdef01234567 "
            "--archive-sha256 $archive_sha256"
        ),
    )
    result.add_argument("archive", type=Path, help="local .tar.zst MCP archive")
    result.add_argument(
        "--lock",
        type=Path,
        required=True,
        metavar="LOCK_PATH",
        help="exact MCP lock used to create the archive",
    )
    result.add_argument(
        "--archive-sha256",
        required=True,
        metavar="SHA256",
        help="trusted lowercase SHA-256 digest for the archive bytes",
    )
    result.add_argument(
        "--build-id",
        required=True,
        metavar="RELEASE_BUILD_ID",
        help="expected 24-character release build ID",
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    validate_build_id(arguments.build_id, "--build-id")
    validate_sha256_digest(arguments.archive_sha256, "--archive-sha256")
    require_commands("zstd")
    lock = load_lock(arguments.lock.expanduser())
    activated = activate_archive(
        arguments.archive,
        local_data_root(),
        extension_root(lock.scriptcat.version),
        arguments.build_id,
        lock.mcp.version,
        lock.scriptcat.version,
        lock.digest,
        expected_archive_sha256=arguments.archive_sha256,
        expected_source_provenance=lock_provenance(lock),
    )
    print(f"activated ScriptCat MCP release {activated}")
    return 0


def lock_provenance(lock: UpstreamLock) -> dict[str, dict[str, str]]:
    return {
        "chrome_devtools_mcp": {
            "upstream_commit": lock.mcp.upstream_commit,
            "build_commit": lock.mcp.commit,
        },
        "scriptcat": {
            "upstream_commit": lock.scriptcat.commit,
            "patch_digest": lock.patch_digest("scriptcat"),
        },
    }


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
