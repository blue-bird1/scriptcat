#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import shlex
import sys
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from remote._common import WorkflowError, cli_main
else:
    from ._common import WorkflowError, cli_main


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = REPOSITORY_ROOT / "browser" / "upstreams.lock.json"
INSTALL_SCRIPT = REPOSITORY_ROOT / "scripts" / "remote" / "install.py"


def migration_install_command() -> tuple[str, ...]:
    return (
        str(INSTALL_SCRIPT),
        "ARCHIVE",
        "--lock",
        str(LOCK_PATH),
        "--build-id",
        "RELEASE_BUILD_ID",
        "--archive-sha256",
        "ARCHIVE_SHA256",
    )


def migration_message() -> str:
    install_command = shlex.join(migration_install_command())
    return (
        "scripts/remote/build_install.py is deprecated; run build.py, package.py, "
        "and install.py as separate explicit stages. After package.py produces the "
        f"archive, SHA-256 sidecar, and release build ID, run: {install_command}"
    )


def parser() -> argparse.ArgumentParser:
    return argparse.ArgumentParser(
        description="Deprecated ScriptCat MCP lifecycle entrypoint.",
        epilog=(
            "This command never builds, packages, downloads, or activates a release. "
            "Run scripts/remote/build.py, then scripts/remote/package.py --build-id, "
            "then the install command reported by this entrypoint."
        ),
    )


def run(argv: Sequence[str]) -> int:
    parser().parse_args(argv)
    raise WorkflowError(migration_message())


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
