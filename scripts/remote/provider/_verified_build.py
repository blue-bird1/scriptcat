from __future__ import annotations

from ._identity import BUILD_SCHEMA, component_build_id
from ._lock import ProviderLock
from .._common import shell_quote


def verified_build_reuse_script(lock: ProviderLock) -> str:
    """Render the validated provider component-reuse gate."""
    build_id = component_build_id(lock.digest)
    return f"""reuse_status=$(python3 - "$build_root/builds" {shell_quote(build_id)} {shell_quote(lock.digest)} {shell_quote(lock.chromium.version)} {shell_quote(lock.depot_tools.version)} {shell_quote(lock.chromium.commit)} {shell_quote(lock.chromium_patch.sha256)} {shell_quote(lock.depot_tools.commit)} <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys

builds = pathlib.Path(sys.argv[1])
build_id, lock_digest, chromium_version, depot_tools_version = sys.argv[2:6]
chromium_commit, patch_digest, depot_tools_commit = sys.argv[6:9]
target = builds / build_id
if not target.exists() and not target.is_symlink():
    print('build')
    raise SystemExit(0)
if target.is_symlink() or not target.is_dir():
    raise SystemExit('existing verified provider component build is invalid')
try:
    raw = json.loads((target / 'build-manifest.json').read_text(encoding='utf-8'))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f'existing verified provider component build is invalid: {{error}}')
expected = {{
    'schema': {BUILD_SCHEMA}, 'build_id': build_id, 'lock_digest': lock_digest,
    'versions': {{'chromium': chromium_version, 'depot_tools': depot_tools_version}},
}}
keys = {{'schema', 'build_id', 'lock_digest', 'source_date_epoch', 'versions', 'provenance', 'files', 'directories'}}
if not isinstance(raw, dict) or set(raw) != keys or any(raw.get(key) != value for key, value in expected.items()):
    raise SystemExit('existing verified provider component build does not match the lock')
if not isinstance(raw.get('source_date_epoch'), int) or isinstance(raw['source_date_epoch'], bool) or raw['source_date_epoch'] <= 0:
    raise SystemExit('existing verified provider component build source date is invalid')
provenance = raw.get('provenance')
chromium = provenance.get('chromium') if isinstance(provenance, dict) else None
if not isinstance(chromium, dict) or set(chromium) != {{'upstream_commit', 'patch_digest', 'build_commit'}} or chromium.get('upstream_commit') != chromium_commit or chromium.get('patch_digest') != patch_digest:
    raise SystemExit('existing verified provider component build Chromium provenance is invalid')
build_commit = chromium.get('build_commit')
if not isinstance(build_commit, str) or len(build_commit) != 40 or any(character not in '0123456789abcdef' for character in build_commit):
    raise SystemExit('existing verified provider component build Chromium build commit is invalid')
if provenance.get('depot_tools') != {{'upstream_commit': depot_tools_commit, 'build_commit': depot_tools_commit}}:
    raise SystemExit('existing verified provider component build depot_tools provenance is invalid')
runtime = target / 'runtime'
if runtime.is_symlink() or not runtime.is_dir() or {{entry.name for entry in runtime.iterdir()}} != {{'chrome-linux'}}:
    raise SystemExit('existing verified provider component build runtime is invalid')
files, directories = {{}}, []
for current, names, file_names in os.walk(runtime, followlinks=False):
    names.sort()
    file_names.sort()
    current_path = pathlib.Path(current)
    for name in names:
        path = current_path / name
        if path.is_symlink() or not stat.S_ISDIR(path.lstat().st_mode):
            raise SystemExit('existing verified provider component build has an invalid directory')
        directories.append(path.relative_to(runtime).as_posix())
    for name in file_names:
        path = current_path / name
        status = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
            raise SystemExit('existing verified provider component build has an invalid file')
        files[path.relative_to(runtime).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
if 'chrome-linux/chrome' not in files or raw.get('files') != dict(sorted(files.items())) or raw.get('directories') != sorted(directories):
    raise SystemExit('existing verified provider component build inventory is invalid')
print('reuse')
PY
)
if [ "$reuse_status" = reuse ]; then
  printf 'reusing verified browser provider component build: %s\\n' {shell_quote(build_id)}
  exit 0
fi
test "$reuse_status" = build
"""


def verified_build_finalize_script(lock: ProviderLock) -> str:
    """Render atomic provider-runtime finalization with product provenance."""
    build_id = component_build_id(lock.digest)
    return f"""python3 - "$runtime" "$build_root/builds" {shell_quote(build_id)} {shell_quote(lock.digest)} "$SOURCE_DATE_EPOCH" {shell_quote(lock.chromium.version)} {shell_quote(lock.depot_tools.version)} {shell_quote(lock.chromium.commit)} {shell_quote(lock.chromium_patch.sha256)} {shell_quote(lock.depot_tools.commit)} "$chromium_build_commit" <<'PY'
import hashlib
import json
import os
import pathlib
import shutil
import stat
import sys

SCHEMA = {BUILD_SCHEMA}
runtime, builds = map(pathlib.Path, sys.argv[1:3])
build_id, lock_digest, source_date_epoch = sys.argv[3:6]
chromium_version, depot_tools_version = sys.argv[6:8]
chromium_commit, patch_digest, depot_tools_commit, chromium_build_commit = sys.argv[8:12]

def fail(message):
    raise SystemExit(message)

def is_hex(value, length):
    return isinstance(value, str) and len(value) == length and all(character in '0123456789abcdef' for character in value)

def inspect(root):
    status = root.lstat()
    if root.is_symlink() or not stat.S_ISDIR(status.st_mode) or {{entry.name for entry in root.iterdir()}} != {{'chrome-linux'}}:
        fail('provider runtime must contain exactly chrome-linux')
    files, directories = {{}}, []
    for current, names, file_names in os.walk(root, followlinks=False):
        names.sort()
        file_names.sort()
        current_path = pathlib.Path(current)
        for name in names:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            if path.is_symlink() or not stat.S_ISDIR(path.lstat().st_mode):
                fail(f'provider runtime has an invalid directory: {{relative}}')
            directories.append(relative)
        for name in file_names:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            status = path.lstat()
            if path.is_symlink() or not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
                fail(f'provider runtime has an invalid file: {{relative}}')
            files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    if 'chrome-linux/chrome' not in files:
        fail('provider runtime omits chrome-linux/chrome')
    return dict(sorted(files.items())), sorted(directories)

if not is_hex(build_id, 24) or not is_hex(lock_digest, 64) or not is_hex(chromium_commit, 40) or not is_hex(patch_digest, 64) or not is_hex(depot_tools_commit, 40) or not is_hex(chromium_build_commit, 40):
    fail('provider build identity or provenance is invalid')
try:
    source_date_epoch = int(source_date_epoch)
except ValueError as error:
    raise SystemExit('provider build source date is invalid') from error
if source_date_epoch <= 0 or not chromium_version or not depot_tools_version:
    fail('provider build source date or versions are invalid')
files, directories = inspect(runtime)
manifest = {{
    'schema': SCHEMA, 'build_id': build_id, 'lock_digest': lock_digest,
    'source_date_epoch': source_date_epoch,
    'versions': {{'chromium': chromium_version, 'depot_tools': depot_tools_version}},
    'provenance': {{
        'chromium': {{'upstream_commit': chromium_commit, 'patch_digest': patch_digest, 'build_commit': chromium_build_commit}},
        'depot_tools': {{'upstream_commit': depot_tools_commit, 'build_commit': depot_tools_commit}},
    }},
    'files': files, 'directories': directories,
}}
builds.mkdir(mode=0o755, parents=True, exist_ok=True)
target = builds / build_id
temporary = builds / f'.{{build_id}}.{{os.getpid()}}.new'
if temporary.exists() or temporary.is_symlink():
    fail(f'unsafe pre-existing provider staging path: {{temporary}}')
try:
    temporary.mkdir(mode=0o755)
    os.replace(runtime, temporary / 'runtime')
    (temporary / 'build-manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\\n', encoding='utf-8')
    if target.exists() or target.is_symlink():
        existing = json.loads((target / 'build-manifest.json').read_text(encoding='utf-8'))
        if existing != manifest:
            fail(f'verified provider component build conflict for {{build_id}}')
        shutil.rmtree(temporary)
        print(f'reusing verified browser provider component build: {{build_id}}')
    else:
        os.replace(temporary, target)
        print(f'created verified browser provider component build: {{build_id}}')
except BaseException:
    if temporary.exists():
        shutil.rmtree(temporary, ignore_errors=True)
    raise
PY
target="$build_root/builds/{build_id}/runtime"
link_stage=$(mktemp -d "$build_root/.links-{build_id}.XXXXXX")
if [ ! -L "$build_root/current" ] || [ "$(readlink "$build_root/current")" != "$target" ]; then
  if [ -L "$build_root/current" ]; then
    ln -s "$(readlink "$build_root/current")" "$link_stage/previous"
    mv -Tf "$link_stage/previous" "$build_root/previous"
  fi
  ln -s "$target" "$link_stage/current"
  mv -Tf "$link_stage/current" "$build_root/current"
fi
rmdir "$link_stage"
test -x "$build_root/current/chrome-linux/chrome"
"""
