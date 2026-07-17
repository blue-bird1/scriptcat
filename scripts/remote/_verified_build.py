# ruff: noqa: E501
from __future__ import annotations

import hashlib
import json
from collections.abc import Collection, Mapping

from ._common import shell_quote
from ._lock import UpstreamLock

MANIFEST_NAME = "build-manifest.json"
BUILD_SCHEMA = 5
PACKAGE_SCHEMA = 5


def component_build_id(lock_digest: str) -> str:
    source = f"mcp-component-v{BUILD_SCHEMA}\0{lock_digest}".encode()
    return hashlib.sha256(source).hexdigest()[:24]


def release_build_id(
    component_id: str,
    runtime_files: Mapping[str, str],
    runtime_directories: Collection[str],
) -> str:
    serialized_inventory = json.dumps(
        {
            "directories": sorted(runtime_directories),
            "files": dict(sorted(runtime_files.items())),
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    source = f"mcp-release-v{PACKAGE_SCHEMA}\0{component_id}\0{serialized_inventory}".encode()
    return hashlib.sha256(source).hexdigest()[:24]


def verified_build_reuse_script(lock: UpstreamLock) -> str:
    build_id = component_build_id(lock.digest)
    return f"""reuse_status=$(python3 - "$build_root/builds" {shell_quote(build_id)} {shell_quote(lock.digest)} {shell_quote(lock.mcp.version)} {shell_quote(lock.mcp.upstream_commit)} {shell_quote(lock.mcp.commit)} <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys

builds, build_id, lock_digest, version, upstream, build_commit = sys.argv[1:]
target = pathlib.Path(builds) / build_id
if not target.exists() and not target.is_symlink():
    print('build')
    raise SystemExit(0)
if target.is_symlink() or not target.is_dir():
    raise SystemExit('existing verified MCP component build is invalid')
try:
    manifest = json.loads((target / 'build-manifest.json').read_text(encoding='utf-8'))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f'existing verified MCP component build is invalid: {{error}}')
expected = {{
    'schema': {BUILD_SCHEMA}, 'build_id': build_id, 'lock_digest': lock_digest,
    'versions': {{'chrome_devtools_mcp': version}},
    'provenance': {{'chrome_devtools_mcp': {{'upstream_commit': upstream, 'build_commit': build_commit}}}},
}}
keys = {{'schema', 'build_id', 'lock_digest', 'source_date_epoch', 'versions', 'provenance', 'files', 'directories'}}
if not isinstance(manifest, dict) or set(manifest) != keys or any(manifest.get(key) != value for key, value in expected.items()):
    raise SystemExit('existing verified MCP component build does not match the lock')
if not isinstance(manifest.get('source_date_epoch'), int) or isinstance(manifest['source_date_epoch'], bool) or manifest['source_date_epoch'] <= 0:
    raise SystemExit('existing verified MCP component build source date is invalid')
runtime = target / 'runtime'
if runtime.is_symlink() or not runtime.is_dir() or {{entry.name for entry in runtime.iterdir()}} != {{'mcp'}}:
    raise SystemExit('existing verified MCP component build runtime is invalid')
files, directories = {{}}, []
for current, names, file_names in os.walk(runtime, followlinks=False):
    names.sort(); file_names.sort(); current_path = pathlib.Path(current)
    for name in names:
        path = current_path / name
        if path.is_symlink() or not stat.S_ISDIR(path.lstat().st_mode):
            raise SystemExit('existing verified MCP component build has an invalid directory')
        directories.append(path.relative_to(runtime).as_posix())
    for name in file_names:
        path = current_path / name; status = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
            raise SystemExit('existing verified MCP component build has an invalid file')
        files[path.relative_to(runtime).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
if 'mcp/bin/chrome-devtools-mcp.js' not in files or manifest.get('files') != dict(sorted(files.items())) or manifest.get('directories') != sorted(directories):
    raise SystemExit('existing verified MCP component build inventory is invalid')
print('reuse')
PY
)
if [ "$reuse_status" = reuse ]; then
  printf 'reusing verified MCP component build: %s\n' {shell_quote(build_id)}
  exit 0
fi
test "$reuse_status" = build
"""


def verified_build_finalize_script(lock: UpstreamLock) -> str:
    build_id = component_build_id(lock.digest)
    return f"""set_phase verified-build-finalize
python3 - "$runtime" "$build_root/builds" {shell_quote(build_id)} {shell_quote(lock.digest)} "$SOURCE_DATE_EPOCH" {shell_quote(lock.mcp.version)} {shell_quote(lock.mcp.upstream_commit)} "$mcp_build_commit" <<'PY'
import hashlib
import json
import os
import pathlib
import shutil
import stat
import sys

runtime, builds, build_id, lock_digest, source_date_epoch, version, upstream, build_commit = sys.argv[1:]
runtime, builds = pathlib.Path(runtime), pathlib.Path(builds)
if not source_date_epoch.isdigit() or int(source_date_epoch) <= 0:
    raise SystemExit('source date epoch is invalid')
if not version or any(len(value) != 40 or any(char not in '0123456789abcdef' for char in value) for value in (upstream, build_commit)):
    raise SystemExit('component lock provenance is invalid')
if runtime.is_symlink() or not runtime.is_dir() or {{entry.name for entry in runtime.iterdir()}} != {{'mcp'}}:
    raise SystemExit('build runtime must contain exactly mcp')
files, directories = {{}}, []
for current, names, file_names in os.walk(runtime, followlinks=False):
    names.sort(); file_names.sort(); current_path = pathlib.Path(current)
    for name in names:
        path = current_path / name; relative = path.relative_to(runtime).as_posix(); status = path.lstat()
        if path.is_symlink() or not stat.S_ISDIR(status.st_mode):
            raise SystemExit(f'build tree contains an unsupported directory: {{relative}}')
        directories.append(relative)
    for name in file_names:
        path = current_path / name; relative = path.relative_to(runtime).as_posix(); status = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
            raise SystemExit(f'build tree contains an unsupported file: {{relative}}')
        files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
if 'mcp/bin/chrome-devtools-mcp.js' not in files:
    raise SystemExit('build runtime omits required MCP file')
manifest = {{
    'schema': {BUILD_SCHEMA}, 'build_id': build_id, 'lock_digest': lock_digest,
    'source_date_epoch': int(source_date_epoch),
    'versions': {{'chrome_devtools_mcp': version}},
    'provenance': {{'chrome_devtools_mcp': {{'upstream_commit': upstream, 'build_commit': build_commit}}}},
    'files': dict(sorted(files.items())), 'directories': sorted(directories),
}}
temporary = builds / f'.{{build_id}}-new'
final = builds / build_id
if temporary.is_symlink() or (temporary.exists() and not temporary.is_dir()):
    raise SystemExit('verified component build staging path is invalid')
if temporary.is_dir():
    shutil.rmtree(temporary)
if final.exists() or final.is_symlink():
    raise SystemExit('verified component build output already exists')
temporary.mkdir(parents=True)
try:
    shutil.copytree(runtime, temporary / 'runtime', copy_function=shutil.copy2)
    (temporary / 'build-manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\\n', encoding='utf-8')
    os.replace(temporary, final)
except BaseException:
    shutil.rmtree(temporary, ignore_errors=True)
    raise
PY
"""
