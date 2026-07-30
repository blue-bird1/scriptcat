#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from mcp._common import cli_main, repository_root
    from mcp._control import load_mcp_invocation, run_shared_control
else:
    from ._common import cli_main, repository_root
    from ._control import load_mcp_invocation, run_shared_control

DEFAULT_CONFIG = Path(".codex/config.toml")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Control the persistent ScriptCat MCP browser broker.",
        epilog=(
            "Reads the chrome-devtools-scriptcat command, environment, entry path, "
            "and browser arguments from .codex/config.toml. status reports the "
            "configured broker. stop requests a non-force shutdown and refuses "
            "active MCP clients; stop --force explicitly interrupts them. The "
            "command creates no credentials or lifecycle state files. Child stdout, "
            "stderr, and exit status are preserved.\n\nExamples:\n"
            "  uv run --project scripts --python 3.12 python "
            "scripts/mcp/control.py status\n"
            "  uv run --project scripts --python 3.12 python "
            "scripts/mcp/control.py stop"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    result.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        metavar="PATH",
        help=f"Codex MCP config (default: {DEFAULT_CONFIG})",
    )
    subcommands = result.add_subparsers(dest="action", required=True)
    subcommands.add_parser("status", help="print broker status JSON")
    stop = subcommands.add_parser(
        "stop", help="stop the broker when no MCP clients are active"
    )
    stop.add_argument(
        "--force",
        action="store_true",
        help="interrupt active MCP clients and stop their browser",
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    root = repository_root()
    config_path = resolve(root, arguments.config)
    invocation = load_mcp_invocation(config_path)
    result = run_shared_control(
        invocation,
        arguments.action,
        force=bool(getattr(arguments, "force", False)),
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode != 0 and not result.stdout and not result.stderr:
        print(
            f"MCP control command exited with status {result.returncode}",
            file=sys.stderr,
        )
    return result.returncode


def resolve(root: Path, path: Path) -> Path:
    expanded = path.expanduser()
    return expanded if expanded.is_absolute() else root / expanded


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
