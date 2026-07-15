#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from remote._activation import activate_archive
    from remote._common import (
        cli_main,
        extension_root,
        local_data_root,
        require_commands,
        validate_build_id,
    )
    from remote._lock import load_lock
else:
    from ._activation import activate_archive
    from ._common import (
        cli_main,
        extension_root,
        local_data_root,
        require_commands,
        validate_build_id,
    )
    from ._lock import load_lock


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Validate and atomically activate a local ScriptCat MCP archive.",
        epilog=(
            "Requires the exact upstream lock used for the release. The archive, "
            "selected lock, and explicit release build ID are cross-checked before "
            "atomic activation under the managed ScriptCat MCP data and extension "
            "roots. This command does not access Git, the remote build host, or the "
            "network, and can run outside a project checkout."
        ),
    )
    result.add_argument(
        "archive",
        type=Path,
        help="local .tar.zst portable archive to validate and activate",
    )
    result.add_argument(
        "--lock",
        type=Path,
        required=True,
        metavar="LOCK_PATH",
        help=(
            "exact upstream lock used to create the archive; relative paths resolve "
            "from the current working directory"
        ),
    )
    result.add_argument(
        "--build-id",
        required=True,
        metavar="RELEASE_BUILD_ID",
        help="expected 24-character release build ID embedded in the archive",
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    validate_build_id(arguments.build_id, "--build-id")
    require_commands("tar", "zstd")
    lock = load_lock(arguments.lock.expanduser())
    build_id = activate_archive(
        arguments.archive,
        local_data_root(),
        extension_root(lock.scriptcat.version),
        arguments.build_id,
        lock.chromium.version,
        lock.mcp.version,
        lock.depot_tools.version,
        lock.scriptcat.version,
        lock.digest,
    )
    print(f"activated ScriptCat MCP portable release {build_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
