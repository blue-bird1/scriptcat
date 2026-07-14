#!/usr/bin/env -S uv run python
# ruff: noqa: E501
from __future__ import annotations

import argparse
import hashlib
import sys
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from remote._activation import activate_archive
    from remote._common import (
        REMOTE_BUILD_ROOT,
        RemoteConfig,
        WorkflowError,
        assert_local_head,
        cli_main,
        local_data_root,
        push_main,
        repository_root,
        require_clean_main,
        require_commands,
        require_wg0,
        run_checked,
        run_remote_script,
        shell_quote,
    )
    from remote._lock import UpstreamLock, load_lock
    from remote._patching import patch_preparation_script
else:
    from ._activation import activate_archive
    from ._common import (
        REMOTE_BUILD_ROOT,
        RemoteConfig,
        WorkflowError,
        assert_local_head,
        cli_main,
        local_data_root,
        push_main,
        repository_root,
        require_clean_main,
        require_commands,
        require_wg0,
        run_checked,
        run_remote_script,
        shell_quote,
    )
    from ._lock import UpstreamLock, load_lock
    from ._patching import patch_preparation_script


LOCK_PATH = Path("browser/upstreams.lock.json")
ARCHIVE_NAME = "scriptcat-mcp-portable.tar.zst"
EXTENSION_ROOT = Path.home() / ".codex" / "chrome-extensions" / "scriptcat" / "v1.3.2"


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description=(
            "Build ScriptCat MCP remotely and atomically activate its portable runtime."
        ),
        epilog=(
            "Requires a clean local main branch and pushes origin/main before remote "
            "work. The fixed remote host uses its own network proxy; no local proxy "
            "is forwarded."
        ),
    )
    result.add_argument(
        "--lock",
        type=Path,
        default=LOCK_PATH,
        help="upstream lock relative to repository root (default: %(default)s)",
    )
    result.add_argument(
        "--archive-only",
        action="store_true",
        help="build and download to /tmp without activating the release",
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    require_commands("git", "ip", "ssh", "rsync", "tar", "zstd")
    require_wg0()
    root = repository_root()
    commit = require_clean_main(root)
    origin = run_checked(
        ("git", "remote", "get-url", "origin"), cwd=root, capture=True
    ).stdout.strip()
    lock = load_lock(root / arguments.lock)
    push_main(root)
    config = RemoteConfig()
    run_remote_script(config, remote_build_script(config, lock, commit, origin))
    assert_local_head(root, commit)
    archive = download_archive(config, lock)
    if arguments.archive_only:
        print(archive)
        return 0
    expected_build_id = hashlib.sha256(f"{lock.digest}{commit}".encode()).hexdigest()[
        :24
    ]
    build_id = activate_archive(
        archive,
        local_data_root(),
        EXTENSION_ROOT,
        expected_build_id,
        lock.chromium.version,
    )
    print(f"activated ScriptCat MCP portable release {build_id}")
    return 0


def download_archive(config: RemoteConfig, lock: UpstreamLock) -> Path:
    local = Path("/tmp") / f"scriptcat-mcp-{lock.digest[:16]}.tar.zst"
    remote = f"{config.build_root}/out/{ARCHIVE_NAME}"
    local.unlink(missing_ok=True)
    try:
        run_checked(
            ("rsync", "--archive", "--partial", f"{config.host}:{remote}", str(local))
        )
    except WorkflowError:
        local.unlink(missing_ok=True)
        raise
    return local


def remote_build_script(
    config: RemoteConfig, lock: UpstreamLock, project_commit: str, project_origin: str
) -> str:
    patch_helpers, patch_commands = patch_preparation_script(lock)
    return f"""#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
build_root={shell_quote(config.build_root)}
checkout={shell_quote(config.checkout)}
test "$build_root" = {shell_quote(REMOTE_BUILD_ROOT)}
mkdir -p "$build_root/src" "$build_root/out"
command -v flock >/dev/null
exec 9>"$build_root/.build.lock"
printf 'waiting for remote build lock: %s\n' "$build_root/.build.lock"
flock -x 9
printf 'acquired remote build lock: %s\n' "$build_root/.build.lock"
exec > >(tee -a "$build_root/out/build.log") 2>&1
trap 'status=$?; trap - ERR; printf "remote build command failed; compiler diagnostics follow\n" >&2; grep -n -E "FAILED:|(^|[^[:alpha:]])(fatal )?error:|ninja: build stopped" "$build_root/out/build.log" | tail -n 80 >&2 || true; printf "remote build log tail follows\n" >&2; tail -n 500 "$build_root/out/build.log" >&2 || true; exit "$status"' ERR
for process_dir in /proc/[0-9]*; do
  process_id="${{process_dir##*/}}"
  test "$process_id" = "$$" && continue
  process_cwd=$(readlink "$process_dir/cwd" 2>/dev/null || true)
  process_command=$(tr '\\0' ' ' < "$process_dir/cmdline" 2>/dev/null || true)
  case "$process_cwd:$process_command" in
    "$build_root"/*:*gclient*|"$build_root"/*:*autoninja*|"$build_root"/*:*ninja*|"$build_root"/*:*browser_tests*)
      printf 'legacy build process is still using %s: pid=%s command=%s\n' \
        "$build_root" "$process_id" "$process_command" >&2
      exit 75
      ;;
  esac
done
project_commit={shell_quote(project_commit)}
project_origin={shell_quote(project_origin)}
if [ ! -d "$checkout/.git" ]; then
  git clone "$project_origin" "$checkout"
fi
git -C "$checkout" fetch --prune origin main
git -C "$checkout" checkout main
git -C "$checkout" reset --hard origin/main
git -C "$checkout" clean -ffd
test "$(git -C "$checkout" rev-parse HEAD)" = "$project_commit"
{patch_helpers}
ensure_chromium_source() {{
  local destination="$build_root/src/src"
  local legacy="$build_root/src/chromium"
  local source="$1" commit="$2"
  if [ ! -d "$destination/.git" ]; then
    if [ -d "$legacy/.git" ] && [ -d "$destination/third_party" ] && [ -f "$build_root/src/.gclient" ]; then
      printf 'adopting partial gclient dependency cache at %s\n' "$destination"
      git -C "$destination" init
      git -C "$destination" remote add bootstrap "$legacy"
      git -C "$destination" fetch --depth=1 bootstrap "$commit"
      git -C "$destination" remote remove bootstrap
      git -C "$destination" remote add origin "$source"
    elif [ -d "$destination" ] && [ -n "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      printf 'refusing to replace unknown non-empty Chromium destination: %s\n' "$destination" >&2
      exit 76
    else
      git clone --filter=blob:none "$source" "$destination"
    fi
  fi
}}
prepare_depot_tools() {{
  local destination="$build_root/depot_tools" source="$1" commit="$2"
  if [ ! -d "$destination/.git" ]; then
    git clone --filter=blob:none "$source" "$destination"
  fi
  git -C "$destination" fetch --depth=1 origin "$commit"
  git -C "$destination" checkout --detach "$commit"
  git -C "$destination" reset --hard "$commit"
  git -C "$destination" clean -ffd
}}
prepare_depot_tools {shell_quote(lock.depot_tools.source)} {shell_quote(lock.depot_tools.commit)}
export PATH="$build_root/depot_tools:$PATH"
export DEPOT_TOOLS_UPDATE=0
"$build_root/depot_tools/ensure_bootstrap"
command -v gclient >/dev/null
command -v gn >/dev/null
command -v autoninja >/dev/null
ensure_chromium_source {shell_quote(lock.chromium.source)} {shell_quote(lock.chromium.commit)}
ensure_source_checkout "$build_root/src/chrome-devtools-mcp" {shell_quote(lock.mcp.source)}
ensure_source_checkout "$build_root/src/scriptcat" {shell_quote(lock.scriptcat.source)}
chromium="$build_root/src/src"
mcp="$build_root/src/chrome-devtools-mcp"
scriptcat="$build_root/src/scriptcat"
runtime="$build_root/out/runtime"
{patch_commands}
if [ -d "$build_root/src/chromium" ]; then
  printf 'removing obsolete non-gclient Chromium checkout: %s\n' "$build_root/src/chromium"
  rm -rf "$build_root/src/chromium"
fi
rm -rf "$runtime"
mkdir -p "$runtime/chromium" "$runtime/mcp" "$runtime/scriptcat"
cd "$build_root/src"
gclient config --unmanaged --name src {shell_quote(lock.chromium.source)}
cd "$chromium"
chromium_head_before_sync=$(git rev-parse HEAD)
checkout_is_clean "$chromium"
sync_chromium() {{
  local attempt=1 delay=120 sync_log="$build_root/out/gclient-sync.log"
  while true; do
    printf 'gclient sync attempt %s/4 with one worker\n' "$attempt"
    if gclient sync -D --nohooks -j 1 2>&1 | tee "$sync_log"; then
      return 0
    fi
    if ! grep -Eqi 'RESOURCE_EXHAUSTED|HTTP[^[:digit:]]*429|error: 429|timed out|connection reset|temporary failure|HTTP[^[:digit:]]*5[0-9][0-9]' "$sync_log"; then
      printf 'gclient sync failed with a non-transient error\n' >&2
      return 1
    fi
    if [ "$attempt" -ge 4 ]; then
      printf 'gclient sync exhausted transient-network retries\n' >&2
      return 1
    fi
    printf 'gclient sync hit a transient remote limit; retrying in %ss\n' "$delay" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}}
sync_chromium
test "$(git rev-parse HEAD)" = "$chromium_head_before_sync"
checkout_is_clean "$chromium"
gclient runhooks
gn gen out/Release --args='is_debug=false is_component_build=false symbol_level=0 blink_symbol_level=0 v8_symbol_level=0 use_remoteexec=false use_siso=false'
generated_extensions_header='out/Release/gen/chrome/browser/devtools/protocol/extensions.h'
blink_protocol_json='out/Release/gen/third_party/blink/public/devtools_protocol/protocol.json'
if grep -q 'command setUserScriptsAccess' third_party/blink/public/devtools_protocol/domains/Extensions.pdl && [ -f "$generated_extensions_header" ] && ! grep -q 'SetUserScriptsAccess' "$generated_extensions_header"; then
  printf '%s\\n' 'invalidating stale generated Extensions protocol'
  rm -f "$blink_protocol_json"
fi
autoninja -C out/Release chrome browser_tests
python3 testing/xvfb.py out/Release/browser_tests \
  --gtest_filter='DevToolsExtensionsProtocolWithUnsafeDebuggingTest.*UserScriptsAccess*:DevToolsExtensionsProtocolWithUnsafeDebuggingTest.RejectsExtensionAbsentFromCurrentProfile:DevToolsExtensionsProtocolTest.CannotSetUserScriptsAccessWithoutUnsafeSwitch' \
  --test-launcher-bot-mode
python3 - infra/archive_config/linux-archive-rel.json out/Release "$runtime/chromium" <<'PY'
import json
import pathlib
import shutil
import sys

config_path, build_path, destination_path = map(pathlib.Path, sys.argv[1:])
archive = json.loads(config_path.read_text(encoding='utf-8'))['archive_datas'][0]
source = build_path.resolve()
destination = destination_path.resolve()
for relative in archive['files']:
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
PY
test -x "$runtime/chromium/chrome-linux/chrome"
cd "$mcp"
pnpm install --frozen-lockfile
pnpm build
pnpm test:no-build -- tests/ProfileLock.test.ts tests/ScriptCatManager.test.ts tests/cli.test.ts
pnpm bundle
rsync -a --delete build/src/ "$runtime/mcp/"
cp package.json LICENSE "$runtime/mcp/"
test -f "$runtime/mcp/bin/chrome-devtools-mcp.js"
node "$runtime/mcp/bin/chrome-devtools-mcp.js" --help >/dev/null
cd "$scriptcat"
pnpm install --frozen-lockfile
pnpm build:managed-mcp
test -f dist/ext/manifest.json
rsync -a --delete --exclude .git dist/ext/ "$runtime/scriptcat/"
test -f "$runtime/scriptcat/manifest.json"
build_id=$(printf '%s' {shell_quote(lock.digest + project_commit)} | sha256sum | cut -c1-24)
python3 - "$runtime" "$build_id" {shell_quote(lock.chromium.version)} <<'PY'
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
files = {{}}
for path in sorted(item for item in root.rglob('*') if item.is_file()):
    relative = path.relative_to(root).as_posix()
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    files[relative] = digest.hexdigest()
(root / 'manifest.json').write_text(
    json.dumps({{'build_id': sys.argv[2], 'chromium_version': sys.argv[3], 'files': files}}, indent=2)
    + '\\n',
    encoding='utf-8',
)
PY
(cd "$runtime" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | \
  xargs -0 sha256sum --zero > SHA256SUMS)
archive_root="$build_root/out/release-$build_id"
rm -rf "$archive_root"
mv "$runtime" "$archive_root"
tar --zstd -C "$build_root/out" -cf "$build_root/out/{ARCHIVE_NAME}" "$(basename "$archive_root")"
printf 'remote build completed: %s\\n' "$build_id"
"""


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
