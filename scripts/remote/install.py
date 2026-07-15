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
        WorkflowError,
        cli_main,
        extension_root,
        git_output,
        local_data_root,
        repository_root,
        require_clean_main,
        require_commands,
        validate_build_id,
    )
    from remote._lock import load_lock
else:
    from ._activation import activate_archive
    from ._common import (
        WorkflowError,
        cli_main,
        extension_root,
        git_output,
        local_data_root,
        repository_root,
        require_clean_main,
        require_commands,
        validate_build_id,
    )
    from ._lock import load_lock


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = Path("browser/upstreams.lock.json")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Validate and atomically activate a local ScriptCat MCP archive.",
        epilog=(
            "Requires a clean, pushed local main checkout. The archive is verified "
            "against the selected upstream lock and current project commit before it "
            "is installed under the managed ScriptCat MCP data and extension roots. "
            "This command does not access the remote build host or the network."
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
        default=LOCK_PATH,
        help="upstream lock relative to the repository root (default: %(default)s)",
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
    require_commands("git", "tar", "zstd")
    root = repository_root()
    project_commit = require_clean_main(root)
    if git_output(root, "rev-parse", "@{upstream}") != project_commit:
        raise WorkflowError(
            "local HEAD is not the pushed main upstream; "
            "package the current build first"
        )
    lock = load_lock(REPOSITORY_ROOT / arguments.lock)
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
        project_commit,
    )
    print(f"activated ScriptCat MCP portable release {build_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
