# ruff: noqa: E501
from __future__ import annotations

from dataclasses import dataclass

from ._common import RemoteConfig, shell_quote
from ._identity import PACKAGE_SCHEMA, RELEASE_GN_ARGS, component_build_id
from ._lock import ProviderLock
from ._patching import chromium_patch_preparation_script
from ._sandbox import provider_protocol_sandbox_helpers
from ._verified_build import (
    verified_build_finalize_script,
    verified_build_reuse_script,
)

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


def remote_build_script(
    config: ProviderRemoteConfig,
    lock: ProviderLock,
    project_commit: str,
    project_origin: str,
) -> str:
    """Render source synchronization and the Chromium-only component build."""
    build_id = component_build_id(lock.digest)
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
if [ ! -d "$checkout/.git" ]; then git clone "$project_origin" "$checkout"; fi
git -C "$checkout" fetch --prune origin main
git -C "$checkout" checkout main
git -C "$checkout" reset --hard origin/main
git -C "$checkout" clean -ffd
test "$(git -C "$checkout" rev-parse HEAD)" = "$project_commit"
{verified_build_reuse_script(lock)}
{patch_helpers}
{provider_protocol_sandbox_helpers()}
prepare_depot_tools() {{
  local destination="$build_root/depot_tools" source="$1" commit="$2"
  if [ ! -d "$destination/.git" ]; then git clone --filter=blob:none "$source" "$destination"; fi
  git -C "$destination" fetch --depth=1 origin "$commit"
  git -C "$destination" checkout --detach "$commit"
  git -C "$destination" reset --hard "$commit"
  git -C "$destination" clean -ffd
}}
prepare_depot_tools {shell_quote(lock.depot_tools.source)} {shell_quote(lock.depot_tools.commit)}
export PATH="$build_root/depot_tools:$PATH" DEPOT_TOOLS_UPDATE=0
"$build_root/depot_tools/ensure_bootstrap"
command -v gclient >/dev/null; command -v gn >/dev/null; command -v autoninja >/dev/null
ensure_source_checkout "$build_root/src/src" {shell_quote(lock.chromium.source)}
chromium="$build_root/src/src"
{patch_commands}
chromium_build_commit=$(git -C "$chromium" rev-parse HEAD)
SOURCE_DATE_EPOCH=$(git -C "$chromium" show -s --format=%ct {shell_quote(lock.chromium.commit)})
test "$SOURCE_DATE_EPOCH" -gt 0
export SOURCE_DATE_EPOCH
cd "$build_root/src"
gclient config --unmanaged --name src {shell_quote(lock.chromium.source)}
cd "$chromium"
gclient sync -D --nohooks -j 1
gclient runhooks
gn gen out/Release --args={shell_quote(" ".join(RELEASE_GN_ARGS))}
autoninja -C out/Release chrome browser_tests
run_provider_protocol_test browser-provider-protocol "$chromium" /usr/bin:/bin '
  "$BROWSER_TESTS_BINARY" \\
    --disable-setuid-sandbox \\
    --ozone-platform=headless \\
    --gtest_filter="DevToolsExtensionsProtocolWithUnsafeDebuggingTest.*UserScriptsAccess*:DevToolsExtensionsProtocolWithUnsafeDebuggingTest.LoadUnpackedUsesManifestKeyForExpectedId:DevToolsExtensionsProtocolWithUnsafeDebuggingTest.LoadUnpackedRejectsExpectedIdMismatchAtomically:DevToolsExtensionsProtocolTest.CannotSetUserScriptsAccessWithoutUnsafeSwitch" \\
    --test-launcher-bot-mode
'
runtime="$build_root/out/runtime-$build_id"
rm -rf "$runtime"; mkdir -p "$runtime"
python3 - infra/archive_config/linux-archive-rel.json out/Release "$runtime" <<'PY'
import json
import pathlib
import shutil
import sys
config_path, build_path, destination = map(pathlib.Path, sys.argv[1:])
archive = json.loads(config_path.read_text(encoding="utf-8"))["archive_datas"][0]
excluded = {{"chrome_sandbox"}}
if not excluded <= set(archive["files"]): raise SystemExit("archive config no longer lists chrome_sandbox")
for relative in archive["files"]:
    if relative in excluded: continue
    source = build_path / relative
    target = destination / "chrome-linux" / relative
    if not source.is_file(): raise SystemExit(f"archive config file is missing: {{source}}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target, follow_symlinks=False)
for relative in archive["dirs"]:
    source = build_path / relative
    target = destination / "chrome-linux" / relative
    if not source.is_dir(): raise SystemExit(f"archive config directory is missing: {{source}}")
    shutil.copytree(source, target, symlinks=True, dirs_exist_ok=True)
if (destination / "chrome-linux" / "chrome_sandbox").exists(): raise SystemExit("setuid sandbox must not be packaged")
PY
test -x "$runtime/chrome-linux/chrome"
find "$build_root/builds" -mindepth 1 -maxdepth 1 -type d -name ".$build_id.*" -exec rm -rf -- {{}} +
find "$build_root" -mindepth 1 -maxdepth 1 -type d -name ".links-$build_id.*" -exec rm -rf -- {{}} +
rm -f "$build_root/.current.new" "$build_root/.previous.new"
{verified_build_finalize_script(lock)}
"""


def remote_component_release_id_command(
    config: ProviderRemoteConfig, component_id: str
) -> str:
    """Render a read-only remote query for a verified component release ID."""
    return f"""python3 - {shell_quote(config.build_root)} {shell_quote(component_id)} <<'PY'
import hashlib
import json
import pathlib
import sys
build_root = pathlib.Path(sys.argv[1])
component_id = sys.argv[2]
raw = json.loads((build_root / "builds" / component_id / "build-manifest.json").read_text(encoding="utf-8"))
files = raw.get("files") if isinstance(raw, dict) else None
directories = raw.get("directories") if isinstance(raw, dict) else None
if not isinstance(files, dict) or any(not isinstance(name, str) or not isinstance(digest, str) for name, digest in files.items()) or not isinstance(directories, list) or any(not isinstance(path, str) for path in directories) or directories != sorted(set(directories)):
    raise SystemExit("provider build manifest runtime inventory is invalid")
serialized = json.dumps({{"files": dict(sorted(files.items())), "directories": directories}}, separators=(",", ":"), sort_keys=True)
source = f"provider-release-v{PACKAGE_SCHEMA}\\0{{component_id}}\\0{{serialized}}".encode()
print(hashlib.sha256(source).hexdigest()[:24])
PY"""


def remote_package_script(
    config: ProviderRemoteConfig,
    lock: ProviderLock,
    component_id: str,
    release_id: str,
    archive_name: str,
) -> str:
    """Render an archive from one verified standalone provider component."""
    return f"""#!/usr/bin/env bash
set -Eeuo pipefail
build_root={shell_quote(config.build_root)}
component_id={shell_quote(component_id)}
release_id={shell_quote(release_id)}
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
  test -f "$candidate_archive"; test -f "$candidate_digest"
  expected=$(awk 'NR == 1 {{ print $1; exit }}' "$candidate_digest")
  test "$expected" = "$(tr -d '\\n' < "$candidate_digest")"; test "$(printf %s "$expected" | wc -c)" -eq 64
  case "$expected" in *[!0123456789abcdef]*) return 1 ;; esac
  actual=$(sha256sum "$candidate_archive" | awk '{{print $1}}')
  test "$actual" = "$expected"; zstd -q --test "$candidate_archive"
}}
recover_package_outputs() {{
  find "$out" -mindepth 1 -maxdepth 1 -type d -name ".package-$release_id.*" -exec rm -rf -- {{}} +
  if [ -e "$archive" ] && [ -e "$digest" ] && verify_archive_pair "$archive" "$digest"; then exit 0; fi
  rm -f -- "$archive" "$digest"
}}
recover_package_outputs
transaction=$(mktemp -d "$out/.package-$release_id.XXXXXX")
release="$transaction/release-$release_id"
archive_temporary="$transaction/$archive_name"
digest_temporary="$archive_temporary.sha256"
published=0
cleanup_package_transaction() {{
  if [ "$published" -ne 1 ]; then rm -f -- "$archive" "$digest"; fi
  rm -rf -- "$transaction" || true
}}
trap cleanup_package_transaction EXIT
test -f "$manifest"
python3 - "$manifest" "$runtime" "$component_id" "$release_id" {shell_quote(lock.digest)} {shell_quote(lock.chromium.version)} {shell_quote(lock.depot_tools.version)} {shell_quote(lock.chromium.commit)} {shell_quote(lock.chromium_patch.sha256)} {shell_quote(lock.depot_tools.commit)} <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys
manifest_path, runtime_path, component_id, release_id, lock_digest, chromium_version, depot_tools_version, chromium_commit, patch_digest, depot_tools_commit = sys.argv[1:]
raw = json.loads(pathlib.Path(manifest_path).read_text(encoding="utf-8"))
keys = {{"schema", "build_id", "lock_digest", "source_date_epoch", "versions", "provenance", "files", "directories"}}
expected = {{"schema": 2, "build_id": component_id, "lock_digest": lock_digest, "versions": {{"chromium": chromium_version, "depot_tools": depot_tools_version}}}}
if not isinstance(raw, dict) or set(raw) != keys or any(raw.get(key) != value for key, value in expected.items()): raise SystemExit("provider build manifest does not match requested package")
epoch, provenance = raw.get("source_date_epoch"), raw.get("provenance")
chromium = provenance.get("chromium") if isinstance(provenance, dict) else None
if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch <= 0 or not isinstance(chromium, dict) or set(chromium) != {{"upstream_commit", "patch_digest", "build_commit"}} or chromium.get("upstream_commit") != chromium_commit or chromium.get("patch_digest") != patch_digest or not isinstance(chromium.get("build_commit"), str) or len(chromium["build_commit"]) != 40 or any(character not in "0123456789abcdef" for character in chromium["build_commit"]) or provenance.get("depot_tools") != {{"upstream_commit": depot_tools_commit, "build_commit": depot_tools_commit}}: raise SystemExit("provider build manifest provenance is invalid")
runtime = pathlib.Path(runtime_path)
files, directories = {{}}, []
for current, names, file_names in os.walk(runtime, followlinks=False):
    names.sort(); file_names.sort(); current_path = pathlib.Path(current)
    for name in names:
        path = current_path / name
        if path.is_symlink() or not stat.S_ISDIR(path.lstat().st_mode): raise SystemExit("unsafe provider runtime directory")
        directories.append(path.relative_to(runtime).as_posix())
    for name in file_names:
        path = current_path / name; status = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(status.st_mode) or status.st_nlink != 1: raise SystemExit("unsafe provider runtime file")
        files[path.relative_to(runtime).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
files, directories = dict(sorted(files.items())), sorted(directories)
if "chrome-linux/chrome" not in files or raw.get("files") != files or raw.get("directories") != directories: raise SystemExit("provider runtime does not match build manifest")
serialized = json.dumps({{"files": files, "directories": directories}}, separators=(",", ":"), sort_keys=True)
calculated = hashlib.sha256(f"provider-release-v2\\0{{component_id}}\\0{{serialized}}".encode()).hexdigest()[:24]
if calculated != release_id: raise SystemExit("provider release identity does not match runtime content")
PY
mkdir "$release"; cp -a "$runtime/." "$release/"
python3 - "$release" "$release_id" "$component_id" {shell_quote(lock.digest)} {shell_quote(lock.chromium.version)} {shell_quote(lock.depot_tools.version)} {shell_quote(lock.chromium.commit)} {shell_quote(lock.chromium_patch.sha256)} {shell_quote(lock.depot_tools.commit)} <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys
root, release_id, component_id, lock_digest, chromium_version, depot_tools_version, chromium_commit, patch_digest, depot_tools_commit = sys.argv[1:]
root = pathlib.Path(root)
files, directories = {{}}, []
for current, names, file_names in os.walk(root, followlinks=False):
    names.sort(); file_names.sort(); current_path = pathlib.Path(current)
    for name in names:
        path = current_path / name
        if path.is_symlink() or not stat.S_ISDIR(path.lstat().st_mode): raise SystemExit("unsafe provider release directory")
        directories.append(path.relative_to(root).as_posix())
    for name in file_names:
        path = current_path / name; status = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(status.st_mode) or status.st_nlink != 1: raise SystemExit("unsafe provider release file")
        files[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
files, directories = dict(sorted(files.items())), sorted(directories)
if "chrome-linux/chrome" not in files: raise SystemExit("provider release omits chrome-linux/chrome")
manifest = {{"schema": 2, "build_id": release_id, "component_build_id": component_id, "lock_digest": lock_digest, "versions": {{"chromium": chromium_version, "depot_tools": depot_tools_version}}, "provenance": {{"chromium": {{"upstream_commit": chromium_commit, "patch_digest": patch_digest}}, "depot_tools": {{"upstream_commit": depot_tools_commit}}}}, "files": files, "directories": directories}}
(root / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\\n", encoding="utf-8")
with (root / "SHA256SUMS").open("wb") as stream:
    for relative in [*sorted(files), "manifest.json"]:
        digest = hashlib.sha256((root / relative).read_bytes()).hexdigest()
        stream.write(digest.encode("ascii") + b"  " + relative.encode("utf-8") + b"\\0")
PY
SOURCE_DATE_EPOCH=$(python3 - "$manifest" <<'PY'
import json
import pathlib
import sys
epoch = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")).get("source_date_epoch")
if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch <= 0: raise SystemExit("provider build manifest source_date_epoch is invalid")
print(epoch)
PY
)
tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner -C "$transaction" -cf - "release-$release_id" | zstd -q -T0 -o "$archive_temporary"
printf '%s\\n' "$(sha256sum "$archive_temporary" | awk '{{print $1}}')" > "$digest_temporary"
verify_archive_pair "$archive_temporary" "$digest_temporary"
mv -f "$archive_temporary" "$archive"; mv -f "$digest_temporary" "$digest"
verify_archive_pair "$archive" "$digest"
published=1
"""
