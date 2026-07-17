#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from remote._common import (
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
    from remote.provider._lock import load_lock, validate_patch_stack
    from remote.provider._remote import (
        ProviderRemoteConfig,
        remote_build_script,
    )
    from remote.provider._identity import component_build_id
else:
    from .._common import (
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
    from ._lock import load_lock, validate_patch_stack
    from ._identity import component_build_id
    from ._remote import ProviderRemoteConfig, remote_build_script


LOCK_PATH = Path("browser/provider.lock.json")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Build and protocol-test a standalone portable Chromium provider.",
        epilog=(
            "Requires a clean local main branch, pushes origin/main, and uses wg0. "
            "It only builds Chromium under /root/scriptcat-browser-build and updates "
            "that root's current/chrome-linux/chrome test-consumption path.\n\n"
            "Example:\n"
            "  uv run --project scripts --python 3.12 python "
            "scripts/remote/provider/build.py"
        ),
    )
    result.add_argument(
        "--lock",
        type=Path,
        default=LOCK_PATH,
        help="provider lock relative to the repository root (default: %(default)s)",
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
    validate_patch_stack(root, lock)
    push_main(root)
    config = ProviderRemoteConfig()
    run_remote_script(
        config.common(), remote_build_script(config, lock, commit, origin)
    )
    assert_local_head(root, commit)
    print(component_build_id(lock.digest))
    return 0


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
