#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from remote._common import WorkflowError, cli_main
else:
    from ._common import WorkflowError, cli_main


def parser() -> argparse.ArgumentParser:
    return argparse.ArgumentParser(
        description="Deprecated ScriptCat MCP lifecycle entrypoint.",
        epilog=(
            "This command never builds, packages, downloads, or activates a release. "
            "Run scripts/remote/build.py, then scripts/remote/package.py --build-id, "
            "then scripts/remote/install.py ARCHIVE --build-id RELEASE_BUILD_ID."
        ),
    )


def run(argv: Sequence[str]) -> int:
    parser().parse_args(argv)
    raise WorkflowError(
        "scripts/remote/build_install.py is deprecated; run build.py, package.py, "
        "and install.py as separate explicit stages"
    )


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
