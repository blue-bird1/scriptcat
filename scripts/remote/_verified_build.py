# ruff: noqa: E501
from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping

from ._common import shell_quote
from ._lock import UpstreamLock

MANIFEST_NAME = "build-manifest.json"
BUILD_SCHEMA = 4
PACKAGE_SCHEMA = 4


def component_build_id(lock_digest: str) -> str:
    """Return the stable identifier for one fully pinned MCP component build."""
    source = f"mcp-component-v{BUILD_SCHEMA}\0{lock_digest}".encode()
    return hashlib.sha256(source).hexdigest()[:24]


def release_build_id(component_id: str, runtime_files: Mapping[str, str]) -> str:
    """Return the reproducible release identifier for one verified runtime map."""
    serialized_files = json.dumps(
        dict(sorted(runtime_files.items())), separators=(",", ":"), sort_keys=True
    )
    source = (
        f"mcp-release-v{PACKAGE_SCHEMA}\0{component_id}\0{serialized_files}"
    ).encode()
    return hashlib.sha256(source).hexdigest()[:24]


def verified_build_reuse_script(lock: UpstreamLock) -> str:
    """Render an early validation and reuse gate for a verified build."""
    build_id = component_build_id(lock.digest)
    return f"""reuse_status=$(python3 - "$build_root/builds" {shell_quote(build_id)} {shell_quote(lock.digest)} {shell_quote(lock.mcp.version)} {shell_quote(lock.scriptcat.version)} {shell_quote(lock.mcp.upstream_commit)} {shell_quote(lock.mcp.commit)} {shell_quote(lock.scriptcat.commit)} {shell_quote(lock.patch_digest("scriptcat"))} <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys

builds = pathlib.Path(sys.argv[1])
build_id, lock_digest, mcp_version, scriptcat_version = sys.argv[2:6]
mcp_upstream, mcp_build, scriptcat_upstream, patch_digest = sys.argv[6:10]
target = builds / build_id
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
    'versions': {{'chrome_devtools_mcp': mcp_version, 'scriptcat': scriptcat_version}},
}}
manifest_keys = {{'schema', 'build_id', 'lock_digest', 'source_date_epoch', 'versions', 'provenance', 'files', 'directories'}}
if not isinstance(manifest, dict) or set(manifest) != manifest_keys or any(manifest.get(key) != value for key, value in expected.items()):
    raise SystemExit('existing verified MCP component build does not match the lock')
if not isinstance(manifest.get('source_date_epoch'), int) or isinstance(manifest['source_date_epoch'], bool) or manifest['source_date_epoch'] <= 0:
    raise SystemExit('existing verified MCP component build source date is invalid')
provenance = manifest.get('provenance')
if not isinstance(provenance, dict) or provenance.get('chrome_devtools_mcp') != {{'upstream_commit': mcp_upstream, 'build_commit': mcp_build}}:
    raise SystemExit('existing verified MCP component build MCP provenance is invalid')
scriptcat = provenance.get('scriptcat')
if not isinstance(scriptcat, dict) or set(scriptcat) != {{'upstream_commit', 'patch_digest', 'build_commit'}} or scriptcat.get('upstream_commit') != scriptcat_upstream or scriptcat.get('patch_digest') != patch_digest or not isinstance(scriptcat.get('build_commit'), str) or len(scriptcat['build_commit']) != 40 or any(character not in '0123456789abcdef' for character in scriptcat['build_commit']):
    raise SystemExit('existing verified MCP component build ScriptCat provenance is invalid')
runtime = target / 'runtime'
files, directories = {{}}, []
if runtime.is_symlink() or not runtime.is_dir() or {{entry.name for entry in runtime.iterdir()}} != {{'mcp', 'scriptcat'}}:
    raise SystemExit('existing verified MCP component build runtime is invalid')
for current, names, file_names in os.walk(runtime, followlinks=False):
    names.sort()
    file_names.sort()
    current_path = pathlib.Path(current)
    for name in names:
        path = current_path / name
        if path.is_symlink() or not stat.S_ISDIR(path.lstat().st_mode):
            raise SystemExit('existing verified MCP component build has an invalid directory')
        directories.append(path.relative_to(runtime).as_posix())
    for name in file_names:
        path = current_path / name
        status = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
            raise SystemExit('existing verified MCP component build has an invalid file')
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        files[path.relative_to(runtime).as_posix()] = digest
if not {{'mcp/bin/chrome-devtools-mcp.js', 'scriptcat/manifest.json'}} <= set(files) or manifest.get('files') != dict(sorted(files.items())) or manifest.get('directories') != sorted(directories):
    raise SystemExit('existing verified MCP component build inventory is invalid')
print('reuse')
PY
)
if [ "$reuse_status" = reuse ]; then
  printf 'reusing verified MCP component build: %s\\n' {shell_quote(build_id)}
  exit 0
fi
test "$reuse_status" = build
"""


def verified_build_finalize_script(lock: UpstreamLock) -> str:
    """Render atomic MCP runtime finalization with exact source provenance."""
    build_id = component_build_id(lock.digest)
    return f"""set_phase verified-build-finalize
python3 - "$runtime" "$build_root/builds" {shell_quote(build_id)} \
  {shell_quote(lock.digest)} "$SOURCE_DATE_EPOCH" \
  {shell_quote(lock.mcp.version)} {shell_quote(lock.scriptcat.version)} \
  {shell_quote(lock.mcp.upstream_commit)} "$mcp_build_commit" \
  {shell_quote(lock.scriptcat.commit)} {shell_quote(lock.patch_digest("scriptcat"))} \
  "$scriptcat_build_commit" <<'PY'
import hashlib
import json
import os
import pathlib
import shutil
import stat
import sys

SCHEMA = {BUILD_SCHEMA}
MANIFEST_NAME = {MANIFEST_NAME!r}
RUNTIME_ROOTS = frozenset({{'mcp', 'scriptcat'}})
REQUIRED_FILES = frozenset({{'mcp/bin/chrome-devtools-mcp.js', 'scriptcat/manifest.json'}})
HEX = frozenset('0123456789abcdef')


def fail(message):
    raise SystemExit(message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def is_hex(value, length):
    return isinstance(value, str) and len(value) == length and all(character in HEX for character in value)


def relative_path(root, path):
    relative = path.relative_to(root).as_posix()
    try:
        relative.encode('utf-8')
    except UnicodeEncodeError:
        fail(f'build tree path is not UTF-8 encodable: {{relative!r}}')
    candidate = pathlib.PurePosixPath(relative)
    if not relative or candidate.is_absolute() or '..' in candidate.parts or candidate.as_posix() != relative:
        fail(f'build tree has an unsafe relative path: {{relative!r}}')
    if MANIFEST_NAME in candidate.parts:
        fail(f'build tree contains a reserved name: {{relative}}')
    return relative


def inspect_runtime(root):
    status = root.lstat()
    if not stat.S_ISDIR(status.st_mode) or root.is_symlink():
        fail(f'build runtime is not a real directory: {{root}}')
    if {{entry.name for entry in root.iterdir()}} != RUNTIME_ROOTS:
        fail(f'build runtime must contain exactly {{sorted(RUNTIME_ROOTS)}}')
    files = {{}}
    directories = []
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        directory_names.sort()
        file_names.sort()
        current_path = pathlib.Path(current)
        for name in directory_names:
            path = current_path / name
            relative = relative_path(root, path)
            status = path.lstat()
            if not stat.S_ISDIR(status.st_mode) or path.is_symlink():
                fail(f'build tree contains a link or special entry: {{relative}}')
            directories.append(relative)
        for name in file_names:
            path = current_path / name
            relative = relative_path(root, path)
            status = path.lstat()
            if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
                fail(f'build tree contains a link or special entry: {{relative}}')
            files[relative] = sha256(path)
    if not REQUIRED_FILES <= set(files):
        fail('build runtime omits required MCP or ScriptCat files')
    return dict(sorted(files.items())), sorted(directories)


def validate_provenance(provenance):
    expected = {{
        'chrome_devtools_mcp': {{'upstream_commit', 'build_commit'}},
        'scriptcat': {{'upstream_commit', 'patch_digest', 'build_commit'}},
    }}
    if not isinstance(provenance, dict) or set(provenance) != set(expected):
        fail('component provenance has an unsupported shape')
    for component, keys in expected.items():
        values = provenance[component]
        if not isinstance(values, dict) or set(values) != keys:
            fail('component provenance has an unsupported shape')
        for key, value in values.items():
            if not is_hex(value, 64 if key == 'patch_digest' else 40):
                fail('component provenance contains an invalid digest or commit')


def manifest_for(runtime, build_id, lock_digest, source_date_epoch, versions, provenance):
    validate_provenance(provenance)
    files, directories = inspect_runtime(runtime)
    return {{
        'schema': SCHEMA,
        'build_id': build_id,
        'lock_digest': lock_digest,
        'source_date_epoch': source_date_epoch,
        'versions': versions,
        'provenance': provenance,
        'files': files,
        'directories': directories,
    }}


def read_verified_manifest(build):
    status = build.lstat()
    if not stat.S_ISDIR(status.st_mode) or build.is_symlink():
        fail(f'verified build is not a real directory: {{build}}')
    path = build / MANIFEST_NAME
    status = path.lstat()
    if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
        fail(f'verified build manifest is not a regular file: {{path}}')
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        fail(f'cannot read verified build manifest {{path}}: {{error}}')
    if not isinstance(payload, dict) or payload.get('schema') != SCHEMA:
        fail(f'invalid verified build manifest: {{path}}')
    actual = manifest_for(
        build / 'runtime', payload.get('build_id'), payload.get('lock_digest'),
        payload.get('source_date_epoch'),
        payload.get('versions'), payload.get('provenance'),
    )
    if actual != payload:
        fail(f'verified build contents do not match its manifest: {{build}}')
    return payload


def write_manifest(path, manifest):
    temporary = path.with_name(f'.{{path.name}}.{{os.getpid()}}.new')
    try:
        temporary.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\\n', encoding='utf-8')
        with temporary.open('rb') as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


runtime = pathlib.Path(sys.argv[1])
builds = pathlib.Path(sys.argv[2])
build_id, lock_digest = sys.argv[3:5]
source_date_epoch = int(sys.argv[5])
versions = {{'chrome_devtools_mcp': sys.argv[6], 'scriptcat': sys.argv[7]}}
mcp_upstream_commit, mcp_build_commit = sys.argv[8:10]
scriptcat_upstream_commit, scriptcat_patch_digest, scriptcat_build_commit = sys.argv[10:13]
if source_date_epoch <= 0 or not is_hex(build_id, 24) or not is_hex(lock_digest, 64):
    fail('build identity or provenance is invalid')
if not all(versions.values()):
    fail('component versions must be non-empty')
provenance = {{
    'chrome_devtools_mcp': {{'upstream_commit': mcp_upstream_commit, 'build_commit': mcp_build_commit}},
    'scriptcat': {{'upstream_commit': scriptcat_upstream_commit, 'patch_digest': scriptcat_patch_digest, 'build_commit': scriptcat_build_commit}},
}}
manifest = manifest_for(runtime, build_id, lock_digest, source_date_epoch, versions, provenance)
builds.mkdir(mode=0o755, parents=True, exist_ok=True)
temporary = builds / f'.{{build_id}}.{{os.getpid()}}.new'
target = builds / build_id
if temporary.exists() or temporary.is_symlink():
    fail(f'unsafe pre-existing temporary build path: {{temporary}}')
try:
    temporary.mkdir(mode=0o755)
    os.replace(runtime, temporary / 'runtime')
    write_manifest(temporary / MANIFEST_NAME, manifest)
    if target.exists() or target.is_symlink():
        existing = read_verified_manifest(target)
        if existing != manifest:
            fail(f'verified component build conflict for {{build_id}}')
        shutil.rmtree(temporary)
        print(f'reusing verified MCP component build: {{build_id}}')
    else:
        os.replace(temporary, target)
        print(f'created verified MCP component build: {{build_id}}')
except BaseException:
    if temporary.exists():
        shutil.rmtree(temporary, ignore_errors=True)
    raise
PY
"""
