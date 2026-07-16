#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from remote._archive import validate_sha256_digest
    from remote._common import cli_main, require_commands, validate_build_id
    from remote.provider._lock import load_lock
    from remote.provider._release import activate_archive, local_data_root
else:
    from .._archive import validate_sha256_digest
    from .._common import cli_main, require_commands, validate_build_id
    from ._lock import load_lock
    from ._release import activate_archive, local_data_root


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=(
            "Validate and atomically activate a standalone Chromium provider archive."
        ),
        epilog=(
            "Activates only under ~/.local/share/scriptcat-browser. This command does "
            "not access Git, the remote host, ScriptCat, MCP, profiles, or extensions."
            "\n\nExample:\n"
            "  uv run --project scripts --python 3.12 python "
            "scripts/remote/provider/install.py /tmp/provider.tar.zst "
            "--lock browser/provider.lock.json --build-id 0123456789abcdef01234567 "
            "--archive-sha256 <sha256>"
        ),
    )
    result.add_argument("archive", type=Path, help="local .tar.zst provider archive")
    result.add_argument(
        "--lock",
        type=Path,
        required=True,
        metavar="LOCK_PATH",
        help="exact provider lock used to create the archive",
    )
    result.add_argument(
        "--archive-sha256",
        required=True,
        metavar="SHA256",
        help="trusted lowercase SHA-256 of the complete archive bytes",
    )
    result.add_argument(
        "--build-id",
        required=True,
        metavar="RELEASE_BUILD_ID",
        help="expected 24-character provider release build ID",
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    validate_build_id(arguments.build_id, "--build-id")
    validate_sha256_digest(arguments.archive_sha256, "--archive-sha256")
    require_commands("tar", "zstd")
    lock = load_lock(arguments.lock.expanduser())
    build_id = activate_archive(
        arguments.archive,
        local_data_root(),
        arguments.build_id,
        arguments.archive_sha256,
        lock,
    )
    print(f"activated browser provider release {build_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
