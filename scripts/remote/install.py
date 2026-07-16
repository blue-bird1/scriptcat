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


LEGACY_TARGETS = (
    "scripts/remote/provider/*",
    "scripts/remote/mcp/*",
)


def parser() -> argparse.ArgumentParser:
    return argparse.ArgumentParser(
        description="Deprecated legacy remote install entrypoint.",
        epilog=(
            "This command never selects, validates, activates, or modifies local "
            "state. Choose an explicit stage under scripts/remote/provider/* or "
            "scripts/remote/mcp/* instead."
        ),
    )


def run(argv: Sequence[str]) -> int:
    parser().parse_args(argv)
    raise WorkflowError(
        "scripts/remote/install.py is deprecated; choose an explicit command under "
        f"{LEGACY_TARGETS[0]} or {LEGACY_TARGETS[1]}; no stage was run"
    )


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
