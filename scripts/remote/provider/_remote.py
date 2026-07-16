# ruff: noqa: E501
from __future__ import annotations

import hashlib
from dataclasses import dataclass

from .._common import RemoteConfig, shell_quote
from ._lock import ProviderLock
from ._patching import chromium_patch_preparation_script
from ._sandbox import provider_protocol_sandbox_helpers

REMOTE_BUILD_ROOT = "/root/scriptcat-browser-build"


@dataclass(frozen=True)
class ProviderRemoteConfig:
    host: str = "root@192.168.50.8"
    checkout: str = f"{REMOTE_BUILD_ROOT}/checkout"
    build_root: str = REMOTE_BUILD_ROOT

    def common(self) -> RemoteConfig:
        return RemoteConfig(
            host=self.host, checkout=self.checkout, build_root=self.build_root
        )


def component_build_id(lock_digest: str, project_commit: str) -> str:
    return hashlib.sha256(f"{lock_digest}{project_commit}".encode()).hexdigest()[:24]


def release_build_id(component_id: str, project_commit: str) -> str:
    return hashlib.sha256(f"{component_id}{project_commit}".encode()).hexdigest()[:24]


def remote_build_script(
    config: ProviderRemoteConfig,
    lock: ProviderLock,
    project_commit: str,
    project_origin: str,
) -> str:
    """Render the Chromium-only remote build and protocol-test workflow."""
    build_id = component_build_id(lock.digest, project_commit)
    patch_helpers, patch_commands = chromium_patch_preparation_script(lock)
    return f"""#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
build_root={shell_quote(config.build_root)}
checkout={shell_quote(config.checkout)}
test "$build_root" = {shell_quote(REMOTE_BUILD_ROOT)}
mkdir -p "$build_root/src" "$build_root/builds" "$build_root/out"
exec 9>"$build_root/.build.lock"
flock -x 9
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
test "$(git -C "$checkout" rev-parse HEAD)" = "$project_commit"
SOURCE_DATE_EPOCH=$(git -C "$checkout" show -s --format=%ct "$project_commit")
test "$SOURCE_DATE_EPOCH" -gt 0
export SOURCE_DATE_EPOCH
{patch_helpers}
{provider_protocol_sandbox_helpers()}
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
ensure_source_checkout "$build_root/src/src" {shell_quote(lock.chromium.source)}
chromium="$build_root/src/src"
{patch_commands}
cd "$build_root/src"
gclient config --unmanaged --name src {shell_quote(lock.chromium.source)}
cd "$chromium"
gclient sync -D --nohooks -j 1
gclient runhooks
gn gen out/Release --args='is_debug=false is_component_build=false symbol_level=0 blink_symbol_level=0 v8_symbol_level=0 use_remoteexec=false use_siso=false'
autoninja -C out/Release chrome browser_tests
run_provider_protocol_test browser-provider-protocol "$chromium" /usr/bin:/bin '
  "$BROWSER_TESTS_BINARY" \\
    --disable-setuid-sandbox \\
    --ozone-platform=headless \\
    --gtest_filter="DevToolsExtensionsProtocolWithUnsafeDebuggingTest.*UserScriptsAccess*:DevToolsExtensionsProtocolWithUnsafeDebuggingTest.LoadUnpackedUsesManifestKeyForExpectedId:DevToolsExtensionsProtocolWithUnsafeDebuggingTest.LoadUnpackedRejectsExpectedIdMismatchAtomically:DevToolsExtensionsProtocolWithUnsafeDebuggingTest.LoadUnpackedFailureRemovesNewExtensionAndState:DevToolsExtensionsProtocolTest.CannotSetUserScriptsAccessWithoutUnsafeSwitch" \\
    --test-launcher-bot-mode
'
runtime="$build_root/out/runtime-$build_id"
rm -rf "$runtime"
mkdir -p "$runtime"
python3 - infra/archive_config/linux-archive-rel.json out/Release "$runtime" <<'PY'
import json
import pathlib
import shutil
import sys

config_path, build_path, destination = map(pathlib.Path, sys.argv[1:])
archive = json.loads(config_path.read_text(encoding="utf-8"))["archive_datas"][0]
excluded = {{"chrome_sandbox"}}
if not excluded <= set(archive["files"]):
    raise SystemExit("archive config no longer lists chrome_sandbox")
for relative in archive["files"]:
    if relative in excluded:
        continue
    source = build_path / relative
    target = destination / "chrome-linux" / relative
    if not source.is_file():
        raise SystemExit(f"archive config file is missing: {{source}}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target, follow_symlinks=False)
for relative in archive["dirs"]:
    source = build_path / relative
    target = destination / "chrome-linux" / relative
    if not source.is_dir():
        raise SystemExit(f"archive config directory is missing: {{source}}")
    shutil.copytree(source, target, symlinks=True, dirs_exist_ok=True)
if (destination / "chrome-linux" / "chrome_sandbox").exists():
    raise SystemExit("setuid sandbox must not be packaged")
PY
test -x "$runtime/chrome-linux/chrome"
final="$build_root/builds/$build_id"
find "$build_root/builds" -mindepth 1 -maxdepth 1 -type d \
  -name ".$build_id.*" -exec rm -rf -- {{}} +
find "$build_root" -mindepth 1 -maxdepth 1 -type d \
  -name ".links-$build_id.*" -exec rm -rf -- {{}} +
rm -f "$build_root/.current.new" "$build_root/.previous.new"
stage=$(mktemp -d "$build_root/builds/.$build_id.XXXXXX")
link_stage=
cleanup_build_transaction() {{
  if [ -n "${{stage:-}}" ]; then
    rm -rf -- "$stage" || true
  fi
  if [ -n "${{link_stage:-}}" ]; then
    rm -rf -- "$link_stage" || true
  fi
}}
trap cleanup_build_transaction EXIT
mv "$runtime" "$stage/runtime"
python3 - "$stage" "$build_id" "$project_commit" {shell_quote(lock.digest)} \\
  "$SOURCE_DATE_EPOCH" {shell_quote(lock.chromium.version)} \\
  {shell_quote(lock.depot_tools.version)} {shell_quote(lock.chromium.commit)} \\
  {shell_quote(lock.chromium_patch.sha256)} {shell_quote(lock.depot_tools.commit)} <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import sys

build, build_id, project_commit, lock_digest, epoch, chromium_version, depot_version, chromium_commit, patch_digest, depot_commit = sys.argv[1:]
runtime = pathlib.Path(build) / "runtime"
files = {{}}
directories = []
for current, names, file_names in os.walk(runtime, followlinks=False):
    names.sort()
    file_names.sort()
    current_path = pathlib.Path(current)
    for name in names:
        path = current_path / name
        if path.is_symlink() or not path.is_dir():
            raise SystemExit(f"unsafe runtime directory: {{path}}")
        directories.append(path.relative_to(runtime).as_posix())
    for name in file_names:
        path = current_path / name
        if not stat.S_ISREG(path.lstat().st_mode) or path.stat().st_nlink != 1:
            raise SystemExit(f"unsafe runtime file: {{path}}")
        files[path.relative_to(runtime).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
if not files or any(not name.startswith("chrome-linux/") for name in files):
    raise SystemExit("provider runtime contains non-browser content")
manifest = {{
    "schema": 1, "build_id": build_id, "project_commit": project_commit,
    "lock_digest": lock_digest, "source_date_epoch": int(epoch),
    "chromium_version": chromium_version, "depot_tools_version": depot_version,
    "provenance": {{
        "chromium": {{
            "upstream_commit": chromium_commit, "patch_digest": patch_digest,
            "build_commit": subprocess.check_output(("git", "rev-parse", "HEAD"), text=True).strip(),
        }},
        "depot_tools": {{"upstream_commit": depot_commit, "build_commit": depot_commit}},
    }},
    "files": dict(sorted(files.items())), "directories": sorted(directories),
}}
(pathlib.Path(build) / "build-manifest.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\\n", encoding="utf-8"
)
PY
if [ -e "$final" ]; then
  cmp "$stage/build-manifest.json" "$final/build-manifest.json"
  rm -rf "$stage"
else
  mv "$stage" "$final"
fi
stage=
link_stage=$(mktemp -d "$build_root/.links-$build_id.XXXXXX")
target="$final/runtime"
if [ ! -L "$build_root/current" ] || [ "$(readlink "$build_root/current")" != "$target" ]; then
  if [ -L "$build_root/current" ]; then
    ln -s "$(readlink "$build_root/current")" "$link_stage/previous"
    mv -Tf "$link_stage/previous" "$build_root/previous"
  fi
  ln -s "$target" "$link_stage/current"
  mv -Tf "$link_stage/current" "$build_root/current"
fi
test -x "$build_root/current/chrome-linux/chrome"
"""


def remote_package_script(
    config: ProviderRemoteConfig,
    lock: ProviderLock,
    component_id: str,
    release_id: str,
    project_commit: str,
    archive_name: str,
) -> str:
    """Render an archive from one verified Chromium-only build."""
    return f"""#!/usr/bin/env bash
set -Eeuo pipefail
build_root={shell_quote(config.build_root)}
component_id={shell_quote(component_id)}
release_id={shell_quote(release_id)}
project_commit={shell_quote(project_commit)}
archive_name={shell_quote(archive_name)}
build="$build_root/builds/$component_id"
runtime="$build/runtime"
manifest="$build/build-manifest.json"
out="$build_root/out"
archive="$out/$archive_name"
digest="$archive.sha256"
mkdir -p "$out"
exec 9>"$build_root/.package.lock"
flock -x 9
verify_archive_pair() {{
  local candidate_archive="$1" candidate_digest="$2" expected actual
  test -f "$candidate_archive"
  test -f "$candidate_digest"
  expected=$(awk 'NR == 1 {{ print $1; exit }}' "$candidate_digest")
  test "$expected" = "$(tr -d '\\n' < "$candidate_digest")"
  test "${{#expected}}" -eq 64
  case "$expected" in
    *[!0123456789abcdef]*) return 1 ;;
  esac
  actual=$(sha256sum "$candidate_archive" | awk '{{print $1}}')
  test "$actual" = "$expected"
  zstd -q --test "$candidate_archive"
}}
recover_package_outputs() {{
  local archive_exists=0 digest_exists=0
  find "$out" -mindepth 1 -maxdepth 1 -type d \
    -name ".package-$release_id.*" -exec rm -rf -- {{}} +
  [ -e "$archive" ] && archive_exists=1
  [ -e "$digest" ] && digest_exists=1
  if [ "$archive_exists" -eq 1 ] && [ "$digest_exists" -eq 1 ]; then
    if verify_archive_pair "$archive" "$digest"; then
      exit 0
    fi
  fi
  rm -f -- "$archive" "$digest"
  find "$out" -mindepth 1 -maxdepth 1 -type d \
    -name ".package-$release_id.*" -exec rm -rf -- {{}} +
}}
recover_package_outputs
transaction=$(mktemp -d "$out/.package-$release_id.XXXXXX")
release="$transaction/release-$release_id"
archive_temporary="$transaction/$archive_name"
digest_temporary="$archive_temporary.sha256"
published=0
cleanup_package_transaction() {{
  if [ "$published" -ne 1 ]; then
    rm -f -- "$archive" "$digest"
  fi
  rm -rf -- "$transaction" || true
}}
trap cleanup_package_transaction EXIT
test -f "$manifest"
python3 - "$manifest" "$runtime" "$component_id" "$project_commit" {shell_quote(lock.digest)} \\
  {shell_quote(lock.chromium.version)} {shell_quote(lock.depot_tools.version)} \\
  {shell_quote(lock.chromium.commit)} {shell_quote(lock.chromium_patch.sha256)} \\
  {shell_quote(lock.depot_tools.commit)} <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys

manifest_path, runtime_path, build_id, project_commit, lock_digest, chromium_version, depot_version, chromium_commit, patch_digest, depot_commit = sys.argv[1:]
raw = json.loads(pathlib.Path(manifest_path).read_text(encoding="utf-8"))
provenance = raw.get("provenance") if isinstance(raw, dict) else None
if (
    not isinstance(raw, dict)
    or raw.get("schema") != 1
    or raw.get("build_id") != build_id
    or raw.get("project_commit") != project_commit
    or raw.get("lock_digest") != lock_digest
    or raw.get("chromium_version") != chromium_version
    or raw.get("depot_tools_version") != depot_version
    or not isinstance(provenance, dict)
    or provenance.get("chromium", {{}}).get("upstream_commit") != chromium_commit
    or provenance.get("chromium", {{}}).get("patch_digest") != patch_digest
    or provenance.get("depot_tools") != {{"upstream_commit": depot_commit, "build_commit": depot_commit}}
):
    raise SystemExit("provider build manifest does not match requested package")
runtime = pathlib.Path(runtime_path)
files = {{}}
directories = []
for current, names, file_names in os.walk(runtime, followlinks=False):
    names.sort()
    file_names.sort()
    current_path = pathlib.Path(current)
    for name in names:
        path = current_path / name
        if path.is_symlink() or not path.is_dir():
            raise SystemExit("unsafe provider runtime directory")
        directories.append(path.relative_to(runtime).as_posix())
    for name in file_names:
        path = current_path / name
        if not stat.S_ISREG(path.lstat().st_mode) or path.stat().st_nlink != 1:
            raise SystemExit("unsafe provider runtime file")
        files[path.relative_to(runtime).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
if raw.get("files") != dict(sorted(files.items())) or raw.get("directories") != sorted(directories):
    raise SystemExit("provider runtime does not match build manifest")
if not files or any(not name.startswith("chrome-linux/") for name in files):
    raise SystemExit("provider runtime contains non-browser content")
PY
mkdir "$release"
cp -a "$runtime/." "$release/"
python3 - "$release" "$release_id" "$component_id" "$project_commit" {shell_quote(lock.digest)} \\
  {shell_quote(lock.chromium.version)} {shell_quote(lock.depot_tools.version)} \\
  {shell_quote(lock.chromium.commit)} {shell_quote(lock.chromium_patch.sha256)} \\
  {shell_quote(lock.depot_tools.commit)} <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys

root, release_id, component_id, project_commit, lock_digest, chromium_version, depot_version, chromium_commit, patch_digest, depot_commit = sys.argv[1:]
root = pathlib.Path(root)
files = {{}}
directories = []
for current, names, file_names in os.walk(root, followlinks=False):
    names.sort()
    file_names.sort()
    current_path = pathlib.Path(current)
    for name in names:
        path = current_path / name
        if path.is_symlink() or not path.is_dir():
            raise SystemExit("unsafe provider release directory")
        directories.append(path.relative_to(root).as_posix())
    for name in file_names:
        path = current_path / name
        if not stat.S_ISREG(path.lstat().st_mode) or path.stat().st_nlink != 1:
            raise SystemExit("unsafe provider release file")
        files[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
if not files or any(not name.startswith("chrome-linux/") for name in files):
    raise SystemExit("provider release contains non-browser content")
manifest = {{
    "schema": 1, "build_id": release_id, "component_build_id": component_id,
    "project_commit": project_commit, "lock_digest": lock_digest,
    "chromium_version": chromium_version, "depot_tools_version": depot_version,
    "provenance": {{
        "chromium": {{"upstream_commit": chromium_commit, "patch_digest": patch_digest}},
        "depot_tools": {{"upstream_commit": depot_commit}},
    }},
    "files": dict(sorted(files.items())), "directories": sorted(directories),
}}
(root / "manifest.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\\n", encoding="utf-8"
)
with (root / "SHA256SUMS").open("wb") as stream:
    for relative in [*sorted(files), "manifest.json"]:
        digest = hashlib.sha256((root / relative).read_bytes()).hexdigest()
        stream.write(digest.encode("ascii") + b"  " + relative.encode("utf-8") + b"\\0")
PY
SOURCE_DATE_EPOCH=$(python3 - "$manifest" <<'PY'
import json
import pathlib
import sys

epoch = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")).get(
    "source_date_epoch"
)
if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch <= 0:
    raise SystemExit("provider build manifest source_date_epoch is invalid")
print(epoch)
PY
)
tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner \\
  -C "$transaction" -cf - "release-$release_id" | zstd -q -T0 -o "$archive_temporary"
printf '%s\\n' "$(sha256sum "$archive_temporary" | awk '{{print $1}}')" > "$digest_temporary"
verify_archive_pair "$archive_temporary" "$digest_temporary"
mv -f "$archive_temporary" "$archive"
mv -f "$digest_temporary" "$digest"
verify_archive_pair "$archive" "$digest"
published=1
"""
