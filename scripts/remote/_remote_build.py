# ruff: noqa: E501
from __future__ import annotations

from ._common import REMOTE_BUILD_ROOT, RemoteConfig, shell_quote
from ._lock import UpstreamLock
from ._patching import patch_preparation_script
from ._verified_build import component_build_id, verified_build_finalize_script


def _browser_test_sandbox_helpers() -> str:
    """Render the shared non-root private mount namespace test launcher."""
    return r"""browser_test_process_group_exists() {
  local expected_process_group=$1 process_dir process_stat process_state process_group
  for process_dir in /proc/[0-9]*; do
    if ! process_stat=$(cat "$process_dir/stat" 2>/dev/null); then
      continue
    fi
    read -r process_state _ process_group _ <<< "${process_stat##*) }"
    [ "$process_state" = Z ] && continue
    if [ "$process_group" = "$expected_process_group" ]; then
      return 0
    fi
  done
  return 1
}
terminate_browser_test_process_group() {
  local process_group=${test_session_pgid:-}
  test_session_pid=
  test_session_pgid=
  [[ "$process_group" =~ ^[0-9]+$ ]] || return 0
  browser_test_process_group_exists "$process_group" || return 0
  printf 'terminating browser test process group: pgid=%s\n' "$process_group" >&2
  kill -TERM -- "-$process_group" 2>/dev/null || true
  for _ in {1..30}; do
    browser_test_process_group_exists "$process_group" || return 0
    sleep 1
  done
  kill -KILL -- "-$process_group" 2>/dev/null || true
}
run_browser_test_in_sandbox() {
  local test_name=$1 test_workdir=$2 test_path=$3 test_command=$4
  local command_file launcher_file test_uid test_gid test_status relative_workdir workdir_kind
  if [[ "$test_workdir" == "$build_root"/* ]]; then
    relative_workdir=${test_workdir#"$build_root"/}
    workdir_kind=build
  elif [[ -n ${mcp:-} && "$test_workdir" == "$mcp" ]]; then
    relative_workdir=
    workdir_kind=mcp
  else
    printf 'browser test workdir is outside the allowed build paths: %s\n' \
      "$test_workdir" >&2
    return 64
  fi
  test_uid=$(id -u nobody)
  test_gid=$(id -g nobody)
  test "$test_uid" -ne 0
  test "$test_gid" -ne 0
  test_root=$(mktemp -d /tmp/scriptcat-browser-tests.XXXXXX)
  chmod 0755 "$test_root"
  install -d -m 0755 "$test_root/build" "$test_root/mcp"
  install -d -m 0700 -o "$test_uid" -g "$test_gid" \
    "$test_root/home" "$test_root/tmp" "$test_root/runtime"
  command_file="$test_root/command.sh"
  install -m 0555 /dev/null "$command_file"
  printf '%s' "$test_command" > "$command_file"
  test -f "$command_file"
  test ! -L "$command_file"
  launcher_file="$test_root/launcher.sh"
  install -m 0555 /dev/null "$launcher_file"
  cat > "$launcher_file" <<'LAUNCHER'
#!/usr/bin/env bash
set -Eeuo pipefail
test_name=${1:?}
build_root=${SANDBOX_SOURCE_BUILD_ROOT:?}
test_root=${SANDBOX_TEST_ROOT:?}
test_uid=${SANDBOX_TEST_UID:?}
test_gid=${SANDBOX_TEST_GID:?}
workdir_kind=${SANDBOX_WORKDIR_KIND:?}
relative_workdir=${SANDBOX_RELATIVE_WORKDIR-}
mcp_workdir=${SANDBOX_MCP_WORKDIR-}
test_path=${SANDBOX_TEST_PATH:?}
command_file=${SANDBOX_COMMAND_FILE:?}
launcher_file=${SANDBOX_LAUNCHER_FILE:?}
case "$launcher_file" in
  "$test_root"/launcher.sh) ;;
  *)
    printf 'browser test launcher file is outside the test root: %s\n' \
      "$launcher_file" >&2
    exit 64
    ;;
esac
case "$command_file" in
  "$test_root"/command.sh) ;;
  *)
    printf 'browser test command file is outside the test root: %s\n' \
      "$command_file" >&2
    exit 64
    ;;
esac
test -f "$launcher_file"
test ! -L "$launcher_file"
test -f "$command_file"
test ! -L "$command_file"
mount --bind "$build_root" "$test_root/build"
case "$workdir_kind" in
  build)
    cd "$test_root/build/$relative_workdir"
    ;;
  mcp)
    mount --bind "$mcp_workdir" "$test_root/mcp"
    mount -o remount,bind,ro "$test_root/mcp"
    cd "$test_root/mcp"
    ;;
  *)
    printf 'browser test workdir kind is invalid: %s\n' "$workdir_kind" >&2
    exit 64
    ;;
esac
exec setpriv \
  --reuid="$test_uid" \
  --regid="$test_gid" \
  --clear-groups \
  --inh-caps=-all \
  --ambient-caps=-all \
  --bounding-set=-all \
  env -i \
    PATH="$test_path" \
    LANG=en_US.UTF-8 \
    HOME="$test_root/home" \
    TMPDIR="$test_root/tmp" \
    XDG_CACHE_HOME="$test_root/home/.cache" \
    XDG_CONFIG_HOME="$test_root/home/.config" \
    XDG_RUNTIME_DIR="$test_root/runtime" \
    SANDBOX_BUILD_ROOT="$test_root/build" \
    BROWSER_BINARY="$test_root/build/src/src/out/Release/chrome" \
    BROWSER_TESTS_BINARY="$test_root/build/src/src/out/Release/browser_tests" \
    /bin/bash -Eeuo pipefail "$command_file"
LAUNCHER
  test -f "$launcher_file"
  test ! -L "$launcher_file"
  env -i \
    PATH=/usr/bin:/bin \
    LANG=en_US.UTF-8 \
    HOME=/root \
    TMPDIR=/tmp \
    SANDBOX_SOURCE_BUILD_ROOT="$build_root" \
    SANDBOX_TEST_ROOT="$test_root" \
    SANDBOX_TEST_UID="$test_uid" \
    SANDBOX_TEST_GID="$test_gid" \
    SANDBOX_WORKDIR_KIND="$workdir_kind" \
    SANDBOX_RELATIVE_WORKDIR="$relative_workdir" \
    SANDBOX_MCP_WORKDIR="${mcp:-}" \
    SANDBOX_TEST_PATH="$test_path" \
    SANDBOX_COMMAND_FILE="$command_file" \
    SANDBOX_LAUNCHER_FILE="$launcher_file" \
    setsid unshare --mount --propagation private /bin/bash "$launcher_file" \
      "$test_name" 9>&- &
  test_session_pid=$!
  test_session_pgid=$test_session_pid
  if wait "$test_session_pid"; then
    test_status=0
  else
    test_status=$?
  fi
  terminate_browser_test_process_group
  rm -rf -- "$test_root"
  test_root=
  return "$test_status"
}"""


def _mcp_checkout_helpers() -> str:
    """Render cleanup and verification for the managed MCP checkout."""
    return r"""# BEGIN managed MCP checkout helpers
clean_mcp_untracked_files() {
  local untracked
  untracked=$(git -C "$mcp" ls-files --others --exclude-standard)
  if [ -z "$untracked" ]; then
    return 0
  fi
  printf 'removing reproducible untracked MCP files before provenance validation:\n' >&2
  printf '%s\n' "$untracked" >&2
  git -C "$mcp" clean -ffd
  untracked=$(git -C "$mcp" ls-files --others --exclude-standard)
  if [ -n "$untracked" ]; then
    printf 'MCP checkout still has untracked files after cleanup:\n%s\n' \
      "$untracked" >&2
    return 1
  fi
}
assert_mcp_checkout_clean() {
  local status
  status=$(git -C "$mcp" status --porcelain)
  if [ -n "$status" ]; then
    printf 'MCP checkout has tracked or untracked drift:\n%s\n' "$status" >&2
    return 1
  fi
}
cleanup_mcp_checkout() {
  if [ -z "${mcp:-}" ] || [ -z "${mcp_commit:-}" ]; then
    return 0
  fi
  if ! git -C "$mcp" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'cannot restore managed MCP checkout: %s\n' "$mcp" >&2
    return 1
  fi
  printf 'restoring managed MCP checkout after build: %s\n' "$mcp" >&2
  git -C "$mcp" reset --hard "$mcp_commit"
  clean_mcp_untracked_files
  assert_mcp_checkout_clean
}
# END managed MCP checkout helpers"""


def remote_build_script(
    config: RemoteConfig, lock: UpstreamLock, project_commit: str, project_origin: str
) -> str:
    """Render the remote-only source sync, build, focused-test, and finalize flow."""
    patch_helpers, patch_commands = patch_preparation_script(lock)
    build_id = component_build_id(lock.digest, project_commit)
    return f"""#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
build_root={shell_quote(config.build_root)}
checkout={shell_quote(config.checkout)}
test \"$build_root\" = {shell_quote(REMOTE_BUILD_ROOT)}
mkdir -p \"$build_root/src\" \"$build_root/out\" \"$build_root/builds\"
command -v flock >/dev/null
exec 9>\"$build_root/.build.lock\"
printf 'waiting for remote build lock: %s\\n' \"$build_root/.build.lock\"
flock -x 9
printf 'acquired remote build lock: %s\\n' \"$build_root/.build.lock\"
run_id=$(date -u +%Y%m%dT%H%M%SZ)-$$
run_log=\"$build_root/out/build-$run_id.log\"
phase=bootstrap
test_root=
test_session_pid=
test_session_pgid=
exec > >(tee \"$run_log\") 2>&1
cleanup_remote_test() {{
  local status=$? cleanup_status
  terminate_browser_test_process_group
  case \"$test_root\" in
    /tmp/scriptcat-browser-tests.*) rm -rf -- \"$test_root\" ;;
  esac
  if declare -F cleanup_mcp_checkout >/dev/null; then
    cleanup_mcp_checkout || {{
      cleanup_status=$?
      printf 'managed MCP checkout cleanup failed: status=%s\\n' \\
        \"$cleanup_status\" >&2
      if [ \"$status\" -eq 0 ]; then
        return \"$cleanup_status\"
      fi
    }}
  fi
  return \"$status\"
}}
report_remote_failure() {{
  local status=$?
  trap - ERR
  printf 'remote build phase failed: %s\\n' \"$phase\" >&2
  printf 'current-run diagnostics follow: %s\\n' \"$run_log\" >&2
  grep -n -E 'FAILED:|(^|[^[:alpha:]])(fatal )?error:|ninja: build stopped|\\[  FAILED  \\]' \"$run_log\" | tail -n 80 >&2 || true
  printf 'current-run log tail follows\\n' >&2
  tail -n 500 \"$run_log\" >&2 || true
  exit \"$status\"
}}
set_phase() {{
  phase=\"$1\"
  printf '== remote build phase: %s ==\\n' \"$phase\"
}}
trap cleanup_remote_test EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap report_remote_failure ERR
for process_dir in /proc/[0-9]*; do
  process_id=\"${{process_dir##*/}}\"
  test \"$process_id\" = \"$$\" && continue
  process_cwd=$(readlink \"$process_dir/cwd\" 2>/dev/null || true)
  process_executable=$(readlink \"$process_dir/exe\" 2>/dev/null || true)
  process_command=$(tr '\\0' ' ' < \"$process_dir/cmdline\" 2>/dev/null || true)
  case \"$process_cwd:$process_executable:$process_command\" in
    \"$build_root\"/*:*gclient*|\"$build_root\"/*:*autoninja*|\"$build_root\"/*:*ninja*|\"$build_root\"/*:*browser_tests*)
      printf 'legacy build process is still using %s: pid=%s command=%s\\n' \\
        \"$build_root\" \"$process_id\" \"$process_command\" >&2
      exit 75
      ;;
    *:\"$build_root\"/src/src/out/Release/chrome:*)
      printf 'legacy Chromium descendant is still using %s: pid=%s command=%s\\n' \\
        \"$build_root\" \"$process_id\" \"$process_command\" >&2
      exit 75
      ;;
  esac
done
project_commit={shell_quote(project_commit)}
project_origin={shell_quote(project_origin)}
build_id={shell_quote(build_id)}
if [ ! -d \"$checkout/.git\" ]; then
  git clone \"$project_origin\" \"$checkout\"
fi
git -C \"$checkout\" fetch --prune origin main
git -C \"$checkout\" checkout main
git -C \"$checkout\" reset --hard origin/main
git -C \"$checkout\" clean -ffd
git -C \"$checkout\" submodule sync --recursive
git -C \"$checkout\" submodule update --init --force --checkout --recursive
test \"$(git -C \"$checkout\" rev-parse HEAD)\" = \"$project_commit\"
SOURCE_DATE_EPOCH=$(git -C \"$checkout\" show -s --format=%ct \"$project_commit\")
test \"$SOURCE_DATE_EPOCH\" -gt 0
export SOURCE_DATE_EPOCH
export SC_MANAGED_MCP_RANDOM_KEY=\"$build_id\"
{patch_helpers}
{_browser_test_sandbox_helpers()}
ensure_chromium_source() {{
  local destination=\"$build_root/src/src\"
  local legacy=\"$build_root/src/chromium\"
  local source=\"$1\" commit=\"$2\"
  if [ ! -d \"$destination/.git\" ]; then
    if [ -d \"$legacy/.git\" ] && [ -d \"$destination/third_party\" ] && [ -f \"$build_root/src/.gclient\" ]; then
      printf 'adopting partial gclient dependency cache at %s\\n' \"$destination\"
      git -C \"$destination\" init
      git -C \"$destination\" remote add bootstrap \"$legacy\"
      git -C \"$destination\" fetch --depth=1 bootstrap \"$commit\"
      git -C \"$destination\" remote remove bootstrap
      git -C \"$destination\" remote add origin \"$source\"
    elif [ -d \"$destination\" ] && [ -n \"$(find \"$destination\" -mindepth 1 -maxdepth 1 -print -quit)\" ]; then
      printf 'refusing to replace unknown non-empty Chromium destination: %s\\n' \"$destination\" >&2
      exit 76
    else
      git clone --filter=blob:none \"$source\" \"$destination\"
    fi
  fi
}}
prepare_depot_tools() {{
  local destination=\"$build_root/depot_tools\" source=\"$1\" commit=\"$2\"
  if [ ! -d \"$destination/.git\" ]; then
    git clone --filter=blob:none \"$source\" \"$destination\"
  fi
  git -C \"$destination\" fetch --depth=1 origin \"$commit\"
  git -C \"$destination\" checkout --detach \"$commit\"
  git -C \"$destination\" reset --hard \"$commit\"
  git -C \"$destination\" clean -ffd
}}
prepare_depot_tools {shell_quote(lock.depot_tools.source)} {shell_quote(lock.depot_tools.commit)}
export PATH=\"$build_root/depot_tools:$PATH\"
export DEPOT_TOOLS_UPDATE=0
\"$build_root/depot_tools/ensure_bootstrap\"
command -v gclient >/dev/null
command -v gn >/dev/null
command -v autoninja >/dev/null
ensure_chromium_source {shell_quote(lock.chromium.source)} {shell_quote(lock.chromium.commit)}
ensure_source_checkout \"$build_root/src/scriptcat\" {shell_quote(lock.scriptcat.source)}
chromium=\"$build_root/src/src\"
mcp=\"$checkout\"/{shell_quote(lock.mcp.submodule_path.as_posix())}
mcp_commit={shell_quote(lock.mcp.commit)}
scriptcat=\"$build_root/src/scriptcat\"
runtime=\"$build_root/out/runtime\"
{_mcp_checkout_helpers()}
{patch_commands}
clean_mcp_untracked_files
test \"$(git -C \"$mcp\" rev-parse HEAD)\" = {shell_quote(lock.mcp.commit)}
test \"$(git -C \"$mcp\" remote get-url origin)\" = {shell_quote(lock.mcp.source)}
git -C \"$mcp\" merge-base --is-ancestor {shell_quote(lock.mcp.upstream_commit)} HEAD
assert_mcp_checkout_clean
if [ -d \"$build_root/src/chromium\" ]; then
  printf 'removing obsolete non-gclient Chromium checkout: %s\\n' \"$build_root/src/chromium\"
  rm -rf \"$build_root/src/chromium\"
fi
rm -rf \"$runtime\"
mkdir -p \"$runtime/chromium\" \"$runtime/mcp\" \"$runtime/scriptcat\"
cd \"$build_root/src\"
gclient config --unmanaged --name src {shell_quote(lock.chromium.source)}
cd \"$chromium\"
chromium_head_before_sync=$(git rev-parse HEAD)
checkout_is_clean \"$chromium\"
sync_chromium() {{
  local attempt=1 delay=120 sync_log=\"$build_root/out/gclient-sync.log\"
  while true; do
    printf 'gclient sync attempt %s/4 with one worker\\n' \"$attempt\"
    if gclient sync -D --nohooks -j 1 2>&1 | tee \"$sync_log\"; then
      return 0
    fi
    if ! grep -Eqi 'RESOURCE_EXHAUSTED|HTTP[^[:digit:]]*429|error: 429|timed out|connection reset|temporary failure|HTTP[^[:digit:]]*5[0-9][0-9]' \"$sync_log\"; then
      printf 'gclient sync failed with a non-transient error\\n' >&2
      return 1
    fi
    if [ \"$attempt\" -ge 4 ]; then
      printf 'gclient sync exhausted transient-network retries\\n' >&2
      return 1
    fi
    printf 'gclient sync hit a transient remote limit; retrying in %ss\\n' \"$delay\" >&2
    sleep \"$delay\"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}}
set_phase gclient-sync
sync_chromium
test \"$(git rev-parse HEAD)\" = \"$chromium_head_before_sync\"
checkout_is_clean \"$chromium\"
set_phase gclient-runhooks
gclient runhooks
set_phase gn-generate
gn gen out/Release --args='is_debug=false is_component_build=false symbol_level=0 blink_symbol_level=0 v8_symbol_level=0 use_remoteexec=false use_siso=false'
set_phase chromium-build
autoninja -C out/Release chrome browser_tests
run_browser_protocol_tests() {{
  run_browser_test_in_sandbox scriptcat-browser-tests \"$chromium\" /usr/bin:/bin '
    \"$BROWSER_TESTS_BINARY\" \\
      --disable-setuid-sandbox \\
      --ozone-platform=headless \\
      --gtest_filter=\"DevToolsExtensionsProtocolWithUnsafeDebuggingTest.*UserScriptsAccess*:DevToolsExtensionsProtocolWithUnsafeDebuggingTest.RejectsExtensionAbsentFromCurrentProfile:DevToolsExtensionsProtocolTest.CannotSetUserScriptsAccessWithoutUnsafeSwitch\" \\
      --test-launcher-bot-mode
  '
}}
set_phase chromium-protocol-tests
run_browser_protocol_tests
set_phase chromium-runtime
python3 - infra/archive_config/linux-archive-rel.json out/Release \"$runtime/chromium\" <<'PY'
import json
import pathlib
import shutil
import sys

config_path, build_path, destination_path = map(pathlib.Path, sys.argv[1:])
archive = json.loads(config_path.read_text(encoding='utf-8'))['archive_datas'][0]
source = build_path.resolve()
destination = destination_path.resolve()
excluded_files = {{'chrome_sandbox'}}
if not excluded_files <= set(archive['files']):
    raise SystemExit('archive config no longer contains the expected setuid sandbox')
for relative in archive['files']:
    if relative in excluded_files:
        continue
    source_file = source / relative
    if not source_file.is_file():
        raise SystemExit(f'archive config file is missing: {{source_file}}')
    target_file = destination / 'chrome-linux' / relative
    target_file.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_file, target_file, follow_symlinks=False)
for relative in archive['dirs']:
    source_dir = source / relative
    if not source_dir.is_dir():
        raise SystemExit(f'archive config directory is missing: {{source_dir}}')
    target_dir = destination / 'chrome-linux' / relative
    shutil.copytree(source_dir, target_dir, symlinks=True, dirs_exist_ok=True)
for relative in excluded_files:
    if (destination / 'chrome-linux' / relative).exists():
        raise SystemExit(f'setuid sandbox must not be packaged: {{relative}}')
PY
test -x \"$runtime/chromium/chrome-linux/chrome\"
cd \"$mcp\"
test -f package-lock.json
set_phase mcp-lock-import
pnpm import
set_phase mcp-install
pnpm install --frozen-lockfile --config.node-linker=hoisted
set_phase mcp-build
pnpm build
set_phase mcp-managed-extension-protection-tests
run_browser_test_in_sandbox scriptcat-mcp-tests "$mcp" "$PATH" '
  PUPPETEER_EXECUTABLE_PATH="$BROWSER_BINARY" \
    node scripts/test.mjs -- tests/ProfileLock.test.ts tests/ScriptCatManager.test.ts tests/cli.test.ts tests/ManagedBrowserShutdown.test.ts tests/ManagedReleaseConsistency.test.ts tests/tools/extensions.test.ts
'
set_phase mcp-bundle
pnpm bundle
rsync -a --delete build/src/ \"$runtime/mcp/\"
cp package.json LICENSE \"$runtime/mcp/\"
test -f \"$runtime/mcp/bin/chrome-devtools-mcp.js\"
node \"$runtime/mcp/bin/chrome-devtools-mcp.js\" --help >/dev/null
set_phase mcp-cleanup
clean_mcp_untracked_files
assert_mcp_checkout_clean
cd \"$scriptcat\"
set_phase scriptcat-install
pnpm install --frozen-lockfile
set_phase scriptcat-tests
pnpm test:ci -- src/app/managed_mcp.test.ts src/app/service/service_worker/regular_updatecheck.test.ts
set_phase scriptcat-build
pnpm build:managed-mcp
test -f dist/ext/manifest.json
rsync -a --delete --exclude .git dist/ext/ \"$runtime/scriptcat/\"
test -f \"$runtime/scriptcat/manifest.json\"
chromium_build_commit=$(git -C \"$chromium\" rev-parse HEAD)
mcp_build_commit=$(git -C \"$mcp\" rev-parse HEAD)
scriptcat_build_commit=$(git -C \"$scriptcat\" rev-parse HEAD)
{verified_build_finalize_script(lock, project_commit)}
printf 'remote component build completed: %s\\n' \"$build_id\"
"""
