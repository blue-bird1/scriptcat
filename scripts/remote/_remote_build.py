# ruff: noqa: E501
from __future__ import annotations

from ._common import REMOTE_BUILD_ROOT, RemoteConfig, shell_quote
from ._lock import UpstreamLock
from ._patching import patch_preparation_script
from ._verified_build import component_build_id, verified_build_finalize_script


def _mcp_test_sandbox_helpers() -> str:
    """Render the non-root private mount namespace MCP test launcher."""
    return r"""test_process_group_exists() {
  local expected=$1 process_dir process_stat process_state process_group
  for process_dir in /proc/[0-9]*; do
    process_stat=$(cat "$process_dir/stat" 2>/dev/null) || continue
    read -r process_state _ process_group _ <<< "${process_stat##*) }"
    [ "$process_state" = Z ] && continue
    [ "$process_group" = "$expected" ] && return 0
  done
  return 1
}

terminate_test_process_group() {
  local process_group=${test_session_pgid:-}
  test_session_pid=
  test_session_pgid=
  [[ "$process_group" =~ ^[0-9]+$ ]] || return 0
  test_process_group_exists "$process_group" || return 0
  kill -TERM -- "-$process_group" 2>/dev/null || true
  for _ in {1..30}; do
    test_process_group_exists "$process_group" || return 0
    sleep 1
  done
  kill -KILL -- "-$process_group" 2>/dev/null || true
}

run_mcp_tests_in_sandbox() {
  local test_command=$1 test_uid test_gid test_status
  local command_file launcher_file
  test_uid=$(id -u nobody)
  test_gid=$(id -g nobody)
  test "$test_uid" -ne 0 && test "$test_gid" -ne 0
  test_root=$(mktemp -d /tmp/scriptcat-mcp-tests.XXXXXX)
  chmod 0755 "$test_root"
  install -d -m 0755 "$test_root/mcp"
  install -d -m 0700 -o "$test_uid" -g "$test_gid" \
    "$test_root/home" "$test_root/tmp" "$test_root/runtime"
  command_file="$test_root/command.sh"
  printf '%s' "$test_command" > "$command_file"
  chmod 0555 "$command_file"
  launcher_file="$test_root/launcher.sh"
  cat > "$launcher_file" <<'LAUNCHER'
#!/usr/bin/env bash
set -Eeuo pipefail
test_root=${SANDBOX_TEST_ROOT:?}
test_uid=${SANDBOX_TEST_UID:?}
test_gid=${SANDBOX_TEST_GID:?}
mcp_source=${SANDBOX_MCP_SOURCE:?}
command_file=${SANDBOX_COMMAND_FILE:?}
mount --bind "$mcp_source" "$test_root/mcp"
mount -o remount,bind,ro "$test_root/mcp"
cd "$test_root/mcp"
exec setpriv \
  --reuid="$test_uid" --regid="$test_gid" --clear-groups \
  --inh-caps=-all --ambient-caps=-all --bounding-set=-all \
  env -i \
    PATH=/usr/bin:/bin \
    LANG=en_US.UTF-8 \
    HOME="$test_root/home" \
    TMPDIR="$test_root/tmp" \
    XDG_CACHE_HOME="$test_root/home/.cache" \
    XDG_CONFIG_HOME="$test_root/home/.config" \
    XDG_RUNTIME_DIR="$test_root/runtime" \
    /bin/bash -Eeuo pipefail "$command_file"
LAUNCHER
  chmod 0555 "$launcher_file"
  env -i \
    PATH=/usr/bin:/bin \
    LANG=en_US.UTF-8 \
    HOME=/root \
    TMPDIR=/tmp \
    SANDBOX_TEST_ROOT="$test_root" \
    SANDBOX_TEST_UID="$test_uid" \
    SANDBOX_TEST_GID="$test_gid" \
    SANDBOX_MCP_SOURCE="$mcp" \
    SANDBOX_COMMAND_FILE="$command_file" \
    setsid unshare --mount --propagation private /bin/bash "$launcher_file" 9>&- &
  test_session_pid=$!
  test_session_pgid=$test_session_pid
  if wait "$test_session_pid"; then
    test_status=0
  else
    test_status=$?
  fi
  terminate_test_process_group
  rm -rf -- "$test_root"
  test_root=
  return "$test_status"
}"""


def _mcp_checkout_helpers() -> str:
    """Render cleanup and verification for the managed MCP checkout."""
    return r"""clean_mcp_untracked_files() {
  local untracked
  untracked=$(git -C "$mcp" ls-files --others --exclude-standard)
  if [ -n "$untracked" ]; then
    git -C "$mcp" clean -ffd
  fi
  test -z "$(git -C "$mcp" ls-files --others --exclude-standard)"
}

assert_mcp_checkout_clean() {
  test -z "$(git -C "$mcp" status --porcelain)"
}

cleanup_mcp_checkout() {
  if [ -z "${mcp:-}" ] || [ -z "${mcp_commit:-}" ]; then
    return 0
  fi
  git -C "$mcp" reset --hard "$mcp_commit"
  clean_mcp_untracked_files
  assert_mcp_checkout_clean
}"""


def remote_build_script(
    config: RemoteConfig, lock: UpstreamLock, project_commit: str, project_origin: str
) -> str:
    """Render MCP/ScriptCat source sync, build, focused tests, and finalization."""
    patch_helpers, patch_command = patch_preparation_script(lock)
    build_id = component_build_id(lock.digest, project_commit)
    return f"""#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
build_root={shell_quote(config.build_root)}
checkout={shell_quote(config.checkout)}
test "$build_root" = {shell_quote(REMOTE_BUILD_ROOT)}
mkdir -p "$build_root/src" "$build_root/out" "$build_root/builds"
command -v flock >/dev/null
exec 9>"$build_root/.build.lock"
flock -x 9
run_id=$(date -u +%Y%m%dT%H%M%SZ)-$$
run_log="$build_root/out/build-$run_id.log"
phase=bootstrap
test_root=
test_session_pid=
test_session_pgid=
mcp=
mcp_commit=
exec > >(tee "$run_log") 2>&1

cleanup_remote_build() {{
  local status=$? cleanup_status
  terminate_test_process_group
  case "$test_root" in
    /tmp/scriptcat-mcp-tests.*) rm -rf -- "$test_root" ;;
  esac
  if declare -F cleanup_mcp_checkout >/dev/null; then
    cleanup_mcp_checkout || {{
      cleanup_status=$?
      [ "$status" -ne 0 ] || return "$cleanup_status"
    }}
  fi
  return "$status"
}}

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

{_mcp_test_sandbox_helpers()}
trap cleanup_remote_build EXIT
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
git -C "$checkout" submodule sync --recursive
git -C "$checkout" submodule update --init --force --checkout --recursive
test "$(git -C "$checkout" rev-parse HEAD)" = "$project_commit"
SOURCE_DATE_EPOCH=$(git -C "$checkout" show -s --format=%ct "$project_commit")
test "$SOURCE_DATE_EPOCH" -gt 0
export SOURCE_DATE_EPOCH
export SC_MANAGED_MCP_RANDOM_KEY="$build_id"

{patch_helpers}
{_mcp_checkout_helpers()}
ensure_source_checkout "$build_root/src/scriptcat" {shell_quote(lock.scriptcat.source)}
mcp="$checkout"/{shell_quote(lock.mcp.submodule_path.as_posix())}
mcp_commit={shell_quote(lock.mcp.commit)}
scriptcat="$build_root/src/scriptcat"
runtime="$build_root/out/runtime"
{patch_command}

clean_mcp_untracked_files
test "$(git -C "$mcp" rev-parse HEAD)" = "$mcp_commit"
test "$(git -C "$mcp" remote get-url origin)" = {shell_quote(lock.mcp.source)}
git -C "$mcp" merge-base --is-ancestor {shell_quote(lock.mcp.upstream_commit)} HEAD
assert_mcp_checkout_clean

rm -rf "$runtime"
mkdir -p "$runtime/mcp" "$runtime/scriptcat"

cd "$mcp"
test -f package-lock.json
set_phase mcp-lock-import
pnpm import
set_phase mcp-install
pnpm install --frozen-lockfile --config.node-linker=hoisted
set_phase mcp-build
pnpm build
set_phase mcp-focused-tests
run_mcp_tests_in_sandbox '
  node scripts/test.mjs -- tests/ProfileLock.test.ts tests/ScriptCatManager.test.ts tests/cli.test.ts tests/ManagedBrowserShutdown.test.ts tests/ManagedExtensionConsistency.test.ts
'
set_phase mcp-bundle
pnpm bundle
rsync -a --delete build/src/ "$runtime/mcp/"
cp package.json LICENSE "$runtime/mcp/"
test -f "$runtime/mcp/bin/chrome-devtools-mcp.js"
node "$runtime/mcp/bin/chrome-devtools-mcp.js" --help >/dev/null
set_phase mcp-cleanup
clean_mcp_untracked_files
assert_mcp_checkout_clean

cd "$scriptcat"
set_phase scriptcat-install
pnpm install --frozen-lockfile
set_phase scriptcat-tests
pnpm test:ci -- src/app/managed_mcp.test.ts src/app/service/service_worker/regular_updatecheck.test.ts
set_phase scriptcat-build
pnpm build:managed-mcp
test -f dist/ext/manifest.json
rsync -a --delete --exclude .git dist/ext/ "$runtime/scriptcat/"
test -f "$runtime/scriptcat/manifest.json"

mcp_build_commit=$(git -C "$mcp" rev-parse HEAD)
scriptcat_build_commit=$(git -C "$scriptcat" rev-parse HEAD)
{verified_build_finalize_script(lock, project_commit)}
printf 'remote MCP component build completed: %s\n' "$build_id"
"""
