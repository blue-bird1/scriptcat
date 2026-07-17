# ruff: noqa: E501
from __future__ import annotations

from ._common import REMOTE_BUILD_ROOT, RemoteConfig, shell_quote
from ._lock import UpstreamLock
from ._verified_build import (
    component_build_id,
    verified_build_finalize_script,
    verified_build_reuse_script,
)


def remote_build_script(
    config: RemoteConfig, lock: UpstreamLock, project_commit: str, project_origin: str
) -> str:
    """Render the isolated MCP source sync, build, test, and finalization flow."""
    build_id = component_build_id(lock.digest)
    return f"""#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
build_root={shell_quote(config.build_root)}
checkout={shell_quote(config.checkout)}
test "$build_root" = {shell_quote(REMOTE_BUILD_ROOT)}
mkdir -p "$build_root/out" "$build_root/builds"
command -v flock >/dev/null
exec 9>"$build_root/.build.lock"
flock -x 9
{verified_build_reuse_script(lock)}
run_id=$(date -u +%Y%m%dT%H%M%SZ)-$$
run_log="$build_root/out/build-$run_id.log"
phase=bootstrap
mcp=
mcp_commit={shell_quote(lock.mcp.commit)}
exec > >(tee "$run_log") 2>&1

report_remote_failure() {{
  local status=$?
  trap - ERR
  printf 'remote MCP build phase failed: %s\n' "$phase" >&2
  tail -n 500 "$run_log" >&2 || true
  exit "$status"
}}

set_phase() {{
  phase="$1"
  printf '== remote MCP build phase: %s ==\n' "$phase"
}}

cleanup_mcp_checkout() {{
  if [ -z "$mcp" ]; then
    return 0
  fi
  git -C "$mcp" reset --hard "$mcp_commit"
  git -C "$mcp" clean -ffd
  test -z "$(git -C "$mcp" status --porcelain)"
}}

trap cleanup_mcp_checkout EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap report_remote_failure ERR

project_commit={shell_quote(project_commit)}
project_origin={shell_quote(project_origin)}
build_id={shell_quote(build_id)}
if [ ! -d "$checkout/.git" ]; then
  git clone "$project_origin" "$checkout"
fi
git -C "$checkout" fetch --prune origin main
git -C "$checkout" checkout main
git -C "$checkout" reset --hard origin/main
git -C "$checkout" clean -ffd
git -C "$checkout" submodule sync -- browser/chrome-devtools-mcp
git -C "$checkout" -c protocol.file.allow=never submodule update --init --force --checkout -- browser/chrome-devtools-mcp
test "$(git -C "$checkout" rev-parse HEAD)" = "$project_commit"

mcp="$checkout"/{shell_quote(lock.mcp.submodule_path.as_posix())}
test "$(git -C "$mcp" rev-parse HEAD)" = "$mcp_commit"
test "$(git -C "$mcp" remote get-url origin)" = {shell_quote(lock.mcp.source)}
git -C "$mcp" merge-base --is-ancestor {shell_quote(lock.mcp.upstream_commit)} HEAD
test -z "$(git -C "$mcp" status --porcelain)"
SOURCE_DATE_EPOCH=$(git -C "$mcp" show -s --format=%ct "$mcp_commit")
test "$SOURCE_DATE_EPOCH" -gt 0
export SOURCE_DATE_EPOCH

runtime="$build_root/out/runtime"
rm -rf "$runtime"
mkdir -p "$runtime/mcp"
cd "$mcp"
test -f package-lock.json
set_phase mcp-lock-import
pnpm import
set_phase mcp-install
pnpm install --frozen-lockfile --config.node-linker=hoisted
set_phase mcp-build
pnpm build
set_phase mcp-focused-tests
node scripts/test.mjs -- tests/cli.test.ts tests/shutdown.test.ts
set_phase mcp-bundle
pnpm bundle
rsync -a --delete build/src/ "$runtime/mcp/"
cp package.json LICENSE "$runtime/mcp/"
test -f "$runtime/mcp/bin/chrome-devtools-mcp.js"
node "$runtime/mcp/bin/chrome-devtools-mcp.js" --help >/dev/null
mcp_build_commit=$(git -C "$mcp" rev-parse HEAD)
cleanup_mcp_checkout
{verified_build_finalize_script(lock)}
printf 'remote MCP component build completed: %s\n' "$build_id"
"""
