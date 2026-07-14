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


REMOTE_DOCTOR = r"""exec bash -s <<'REMOTE_DOCTOR_SCRIPT'
set -Eeuo pipefail

fail() {
  printf 'remote doctor failed: %s\n' "$*" >&2
  exit 1
}

require_command() {
  local tool="$1"
  command -v "$tool" >/dev/null 2>&1 || \
    fail "required remote command is unavailable: $tool"
}

test "$(uname -s)" = Linux || fail "remote host must run Linux"
test "$(uname -m)" = x86_64 || fail "remote host must use x86_64"

available_kib=$(df -Pk /root | awk 'NR == 2 { print $4 }')
managed_kib=0
if [ -d /root/scriptcat-mcp-build ]; then
  managed_kib=$(du -sk /root/scriptcat-mcp-build | awk '{ print $1 }')
fi
workspace_kib=$((available_kib + managed_kib))
test "$workspace_kib" -ge $((160 * 1024 * 1024)) || \
  fail "remote managed build workspace needs at least 160 GiB total capacity"

memory_kib=$(awk '/MemTotal:/ { print $2 }' /proc/meminfo)
test "$memory_kib" -ge $((16 * 1024 * 1024)) || \
  fail "remote host needs at least 16 GiB RAM"

test "$(sysctl -n kernel.unprivileged_userns_clone)" = 1 || \
  fail "kernel.unprivileged_userns_clone must be enabled for Chromium"

for tool in \
  awk bash cat cp curl cut date df du env find flock getent git grep head id \
  install mkdir mktemp mount mv node pnpm python3 readlink rm rsync sed \
  setpriv setsid sha256sum sleep sort tail tar tee timeout tr unshare wc \
  xargs Xvfb zstd; do
  require_command "$tool"
done

test_uid=$(id -u nobody 2>/dev/null) || fail "remote nobody account is unavailable"
test_gid=$(id -g nobody 2>/dev/null) || fail "remote nobody group is unavailable"
test "$test_uid" -ne 0 || fail "remote nobody account must not use uid 0"
test "$test_gid" -ne 0 || fail "remote nobody group must not use gid 0"
unshare --mount --propagation private true >/dev/null 2>&1 || \
  fail "remote root cannot create a private mount namespace"
setpriv --reuid="$test_uid" --regid="$test_gid" --clear-groups \
  --inh-caps=-all --ambient-caps=-all --bounding-set=-all true || \
  fail "remote browser tests cannot drop privileges to nobody"

node_version=$(node --version 2>/dev/null) || fail "Node.js version check failed"
if [[ ! "$node_version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  fail "Node.js reports an unsupported version: $node_version"
fi
node_major=${BASH_REMATCH[1]}
node_minor=${BASH_REMATCH[2]}
if ((node_major < 20 || (node_major == 20 && node_minor < 19))); then
  fail "Node.js $node_version is too old; require Node.js >= v20.19.0"
fi

pnpm --version >/dev/null 2>&1 || fail "pnpm is installed but cannot run"
tar --zstd -cf /dev/null --files-from /dev/null >/dev/null 2>&1 || \
  fail "tar must support --zstd archive creation"

timeout 30 curl --fail --silent --show-error --head https://github.com >/dev/null || \
  fail "remote network cannot reach https://github.com through its configured proxy"
timeout 30 curl --fail --silent --show-error --head \
  https://chromium.googlesource.com >/dev/null || \
  fail "remote network cannot reach https://chromium.googlesource.com through its configured proxy"

mkdir -p /root/scriptcat-mcp-build || \
  fail "cannot create remote build root: /root/scriptcat-mcp-build"
printf 'remote doctor passed: node=%s free_kib=%s managed_kib=%s workspace_kib=%s memory_kib=%s build_root=%s\n' \
  "$node_version" "$available_kib" "$managed_kib" "$workspace_kib" \
  "$memory_kib" /root/scriptcat-mcp-build
REMOTE_DOCTOR_SCRIPT
"""


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description=(
            "Check local WireGuard and remote ScriptCat MCP build prerequisites."
        ),
        epilog=(
            "Uses root@192.168.50.8 directly; the remote host owns its proxy settings "
            "and no proxy tunnel is created. Checks Node.js >= 20.19.0, pnpm, tar "
            "with zstd support, rsync, Xvfb, private mount namespaces, and an "
            "unprivileged nobody test account. "
            "Requires at least 160 GiB across free space and the existing managed "
            "build cache, then creates /root/scriptcat-mcp-build if needed."
        ),
    )
    result.add_argument(
        "--json",
        action="store_true",
        help="emit fixed target details as JSON after all checks pass",
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
