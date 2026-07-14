from __future__ import annotations

import hashlib

from ._common import shell_quote
from ._lock import UpstreamLock

MANIFEST_NAME = "build-manifest.json"
BUILD_SCHEMA = 1


def component_build_id(lock_digest: str, project_commit: str) -> str:
    """Return the stable identifier for one fully pinned component build."""
    return hashlib.sha256(f"{lock_digest}{project_commit}".encode()).hexdigest()[:24]


def verified_build_finalize_script(lock: UpstreamLock, project_commit: str) -> str:
    """Render the remote, atomic runtime-to-verified-build finalization stage.

    The caller must define ``build_root``, ``runtime``, ``build_id`` and
    ``SOURCE_DATE_EPOCH`` before running this fragment.  On success it leaves a
    verified component build at ``$build_root/builds/$build_id`` and consumes
    ``$runtime``.
    """
    build_id = component_build_id(lock.digest, project_commit)
    return f"""set_phase verified-build-finalize
test \"$build_id\" = {shell_quote(build_id)}
python3 - \"$runtime\" \"$build_root/builds\" \"$build_id\" \\
  {shell_quote(project_commit)} {shell_quote(lock.digest)} \"$SOURCE_DATE_EPOCH\" \\
  {shell_quote(lock.chromium.version)} {shell_quote(lock.mcp.version)} \\
  {shell_quote(lock.depot_tools.version)} {shell_quote(lock.scriptcat.version)} <<'PY'
import hashlib
import json
import os
import pathlib
import shutil
import stat
import sys


SCHEMA = {BUILD_SCHEMA}
MANIFEST_NAME = {MANIFEST_NAME!r}
COMPONENTS = frozenset({{'chromium', 'mcp', 'scriptcat'}})
RESERVED_NAMES = frozenset({{MANIFEST_NAME}})


def fail(message):
    raise SystemExit(message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def checked_relative(root, path):
    relative = path.relative_to(root).as_posix()
    try:
        relative.encode('utf-8')
    except UnicodeEncodeError as error:
        fail(f'build tree path is not UTF-8 encodable: {{relative!r}}')
    if not relative or relative.startswith('../') or '/..' in relative:
        fail(f'build tree has an unsafe relative path: {{relative!r}}')
    if any(part in RESERVED_NAMES for part in pathlib.PurePosixPath(relative).parts):
        fail(f'build tree contains a reserved name: {{relative}}')
    return relative


def inspect_runtime(root):
    status = root.lstat()
    if not stat.S_ISDIR(status.st_mode) or stat.S_ISLNK(status.st_mode):
        fail(f'build runtime is not a directory: {{root}}')
    names = {{entry.name for entry in root.iterdir()}}
    if names != COMPONENTS:
        fail(f'build runtime must contain exactly {{sorted(COMPONENTS)}}: {{root}}')
    files = {{}}
    directories = []
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        directory_names.sort()
        file_names.sort()
        current_path = pathlib.Path(current)
        for name in directory_names:
            path = current_path / name
            entry_status = path.lstat()
            relative = checked_relative(root, path)
            if not (
                stat.S_ISDIR(entry_status.st_mode)
                and not stat.S_ISLNK(entry_status.st_mode)
            ):
                fail(f'build tree contains a link or special entry: {{relative}}')
            directories.append(relative)
        for name in file_names:
            path = current_path / name
            entry_status = path.lstat()
            relative = checked_relative(root, path)
            if not stat.S_ISREG(entry_status.st_mode) or entry_status.st_nlink != 1:
                fail(f'build tree contains a link or special entry: {{relative}}')
            files[relative] = sha256(path)
    return dict(sorted(files.items())), sorted(directories)


def manifest_for(runtime, build_id, project_commit, lock_digest, source_date_epoch,
                 chromium_version, mcp_version, depot_tools_version, scriptcat_version):
    files, directories = inspect_runtime(runtime)
    return {{
        'schema': SCHEMA,
        'build_id': build_id,
        'project_commit': project_commit,
        'lock_digest': lock_digest,
        'source_date_epoch': source_date_epoch,
        'chromium_version': chromium_version,
        'mcp_version': mcp_version,
        'depot_tools_version': depot_tools_version,
        'scriptcat_version': scriptcat_version,
        'files': files,
        'directories': directories,
    }}


def read_verified_manifest(build):
    build_status = build.lstat()
    if not stat.S_ISDIR(build_status.st_mode) or stat.S_ISLNK(build_status.st_mode):
        fail(f'verified build is not a directory: {{build}}')
    manifest_path = build / MANIFEST_NAME
    manifest_status = manifest_path.lstat()
    if not stat.S_ISREG(manifest_status.st_mode) or manifest_status.st_nlink != 1:
        fail(f'verified build manifest is not a regular file: {{manifest_path}}')
    try:
        payload = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        fail(f'cannot read verified build manifest {{manifest_path}}: {{error}}')
    if not isinstance(payload, dict) or payload.get('schema') != SCHEMA:
        fail(f'invalid verified build manifest: {{manifest_path}}')
    runtime = build / 'runtime'
    actual = manifest_for(
        runtime,
        payload.get('build_id'),
        payload.get('project_commit'),
        payload.get('lock_digest'),
        payload.get('source_date_epoch'),
        payload.get('chromium_version'),
        payload.get('mcp_version'),
        payload.get('depot_tools_version'),
        payload.get('scriptcat_version'),
    )
    if actual != payload:
        fail(f'verified build contents do not match its manifest: {{build}}')
    return payload


def write_manifest(path, manifest):
    temporary = path.with_name(f'.{{path.name}}.{{os.getpid()}}.new')
    try:
        temporary.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + '\\n', encoding='utf-8'
        )
        with temporary.open('rb') as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


runtime = pathlib.Path(sys.argv[1])
builds = pathlib.Path(sys.argv[2])
build_id, project_commit, lock_digest = sys.argv[3:6]
source_date_epoch = int(sys.argv[6])
versions = sys.argv[7:11]
if source_date_epoch <= 0:
    fail('SOURCE_DATE_EPOCH must be positive')
if len(build_id) != 24 or any(
    character not in '0123456789abcdef' for character in build_id
):
    fail(f'unsafe component build ID: {{build_id}}')
if not all(versions):
    fail('component versions must be non-empty')

manifest = manifest_for(
    runtime,
    build_id,
    project_commit,
    lock_digest,
    source_date_epoch,
    *versions,
)
builds.mkdir(mode=0o755, parents=True, exist_ok=True)
temporary = builds / f'.{{build_id}}.{{os.getpid()}}.new'
target = builds / build_id
if temporary.exists():
    fail(f'unsafe pre-existing temporary build path: {{temporary}}')
try:
    temporary.mkdir(mode=0o755)
    os.replace(runtime, temporary / 'runtime')
    write_manifest(temporary / MANIFEST_NAME, manifest)
    if target.exists() or target.is_symlink():
        existing = read_verified_manifest(target)
        if existing == manifest:
            shutil.rmtree(temporary)
            print(f'reusing verified component build: {{build_id}}')
        else:
            fail(
                f'verified component build conflict for {{build_id}}: existing '
                'manifest differs; refusing to replace it'
            )
    else:
        os.replace(temporary, target)
        print(f'created verified component build: {{build_id}}')
except BaseException:
    if temporary.exists():
        shutil.rmtree(temporary, ignore_errors=True)
    raise
PY
"""
