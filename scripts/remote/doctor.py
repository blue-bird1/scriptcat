#!/usr/bin/env -S uv run python
# ruff: noqa: E501
from __future__ import annotations

import argparse
import json
import platform
import sys
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from remote._common import (
        REMOTE_BUILD_ROOT,
        REMOTE_CHECKOUT,
        RemoteConfig,
        cli_main,
        remote_checked,
        require_commands,
        require_wg0,
    )
else:
    from ._common import (
        REMOTE_BUILD_ROOT,
        REMOTE_CHECKOUT,
        RemoteConfig,
        cli_main,
        remote_checked,
        require_commands,
        require_wg0,
    )


REMOTE_DOCTOR = r"""
set -euo pipefail
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
available_kib=$(df -Pk /root | awk 'NR == 2 { print $4 }')
test "$available_kib" -ge $((160 * 1024 * 1024))
memory_kib=$(awk '/MemTotal:/ { print $2 }' /proc/meminfo)
test "$memory_kib" -ge $((16 * 1024 * 1024))
test "$(sysctl -n kernel.unprivileged_userns_clone)" = 1
for tool in git curl python3 node pnpm tar zstd rsync Xvfb; do
  command -v "$tool" >/dev/null
done
timeout 30 curl --fail --silent --show-error --head https://github.com >/dev/null
timeout 30 curl --fail --silent --show-error --head https://chromium.googlesource.com >/dev/null
mkdir -p /root/scriptcat-mcp-build
printf 'remote doctor passed: disk_kib=%s memory_kib=%s build_root=%s\n' \
  "$available_kib" "$memory_kib" /root/scriptcat-mcp-build
"""


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Check local WG and the fixed ScriptCat MCP build server.",
        epilog=(
            "Uses root@192.168.50.8 directly; the remote host owns its proxy settings "
            "and no proxy tunnel is created."
        ),
    )
    result.add_argument(
        "--json", action="store_true", help="emit the fixed target details"
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    require_commands("ip", "ssh")
    require_wg0()
    config = RemoteConfig()
    remote_checked(config, REMOTE_DOCTOR)
    if arguments.json:
        print(
            json.dumps(
                {
                    "local_architecture": platform.machine(),
                    "host": config.host,
                    "checkout": REMOTE_CHECKOUT,
                    "build_root": REMOTE_BUILD_ROOT,
                }
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
