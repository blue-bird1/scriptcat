# ruff: noqa: E501
from __future__ import annotations

import hashlib

from ._common import shell_quote
from ._lock import UpstreamLock

MANIFEST_NAME = "build-manifest.json"
BUILD_SCHEMA = 3


def component_build_id(lock_digest: str, project_commit: str) -> str:
    """Return the stable identifier for one fully pinned MCP component build."""
    return hashlib.sha256(f"{lock_digest}{project_commit}".encode()).hexdigest()[:24]


def verified_build_finalize_script(lock: UpstreamLock, project_commit: str) -> str:
    """Render atomic MCP runtime finalization with exact source provenance."""
    build_id = component_build_id(lock.digest, project_commit)
    return f"""set_phase verified-build-finalize
python3 - "$runtime" "$build_root/builds" {shell_quote(build_id)} \
  {shell_quote(project_commit)} {shell_quote(lock.digest)} "$SOURCE_DATE_EPOCH" \
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


def manifest_for(runtime, build_id, project_commit, lock_digest, source_date_epoch, versions, provenance):
    validate_provenance(provenance)
    files, directories = inspect_runtime(runtime)
    return {{
        'schema': SCHEMA,
        'build_id': build_id,
        'project_commit': project_commit,
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
        build / 'runtime', payload.get('build_id'), payload.get('project_commit'),
        payload.get('lock_digest'), payload.get('source_date_epoch'),
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
build_id, project_commit, lock_digest = sys.argv[3:6]
source_date_epoch = int(sys.argv[6])
versions = {{'chrome_devtools_mcp': sys.argv[7], 'scriptcat': sys.argv[8]}}
mcp_upstream_commit, mcp_build_commit = sys.argv[9:11]
scriptcat_upstream_commit, scriptcat_patch_digest, scriptcat_build_commit = sys.argv[11:14]
if source_date_epoch <= 0 or not is_hex(build_id, 24) or not is_hex(project_commit, 40) or not is_hex(lock_digest, 64):
    fail('build identity or provenance is invalid')
if not all(versions.values()):
    fail('component versions must be non-empty')
provenance = {{
    'chrome_devtools_mcp': {{'upstream_commit': mcp_upstream_commit, 'build_commit': mcp_build_commit}},
    'scriptcat': {{'upstream_commit': scriptcat_upstream_commit, 'patch_digest': scriptcat_patch_digest, 'build_commit': scriptcat_build_commit}},
}}
manifest = manifest_for(runtime, build_id, project_commit, lock_digest, source_date_epoch, versions, provenance)
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
