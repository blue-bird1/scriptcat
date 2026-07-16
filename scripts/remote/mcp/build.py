#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from remote._common import (
        RemoteConfig,
        assert_local_head,
        cli_main,
        push_main,
        repository_root,
        require_clean_main,
        require_commands,
        require_wg0,
        run_checked,
        run_remote_script,
    )
    from remote._lock import load_lock, validate_mcp_submodule, validate_patch_stacks
    from remote._remote_build import remote_build_script
    from remote._verified_build import component_build_id
else:
    from .._common import (
        RemoteConfig,
        assert_local_head,
        cli_main,
        push_main,
        repository_root,
        require_clean_main,
        require_commands,
        require_wg0,
        run_checked,
        run_remote_script,
    )
    from .._lock import load_lock, validate_mcp_submodule, validate_patch_stacks
    from .._remote_build import remote_build_script
    from .._verified_build import component_build_id

LOCK_PATH = Path("browser/mcp.lock.json")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=(
            "Build and focus-test an MCP/ScriptCat component on the managed remote "
            "host."
        ),
        epilog=(
            "Requires a clean local main branch, pushes origin/main, and uses wg0. "
            "This product build only compiles and tests MCP/ScriptCat sources. "
            "Cross-product integration is validated after independent installation. "
            "This command does not package, download, or activate a release.\n\n"
            "Example:\n"
            "  uv run --project scripts --python 3.12 python "
            "scripts/remote/mcp/build.py"
        ),
    )
    result.add_argument(
        "--lock",
        type=Path,
        default=LOCK_PATH,
        help="MCP lock relative to the repository root (default: %(default)s)",
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    require_commands("git", "ip", "ssh")
    require_wg0()
    root = repository_root()
    commit = require_clean_main(root)
    origin = run_checked(
        ("git", "remote", "get-url", "origin"), cwd=root, capture=True
    ).stdout.strip()
    lock = load_lock(root / arguments.lock)
    validate_patch_stacks(root, lock)
    validate_mcp_submodule(root, lock)
    push_main(root)
    config = RemoteConfig()
    run_remote_script(config, remote_build_script(config, lock, commit, origin))
    assert_local_head(root, commit)
    print(component_build_id(lock.digest, commit))
    return 0


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
