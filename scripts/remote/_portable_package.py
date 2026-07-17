# ruff: noqa: E501
from __future__ import annotations

import re
import textwrap

from ._common import REMOTE_BUILD_ROOT, WorkflowError, shell_quote, validate_build_id
from ._lock import UpstreamLock
from ._verified_build import BUILD_SCHEMA, PACKAGE_SCHEMA

_ARCHIVE_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.zst")


def portable_package_script(
    archive_name: str,
    lock: UpstreamLock,
    *,
    component_build_id: str,
    build_root: str = REMOTE_BUILD_ROOT,
) -> str:
    """Generate the self-contained MCP packaging program for a verified build."""
    validate_build_id(component_build_id, "component build ID")
    if not _ARCHIVE_NAME_PATTERN.fullmatch(archive_name):
        raise WorkflowError(f"archive name is unsafe or unsupported: {archive_name!r}")
    return textwrap.dedent(
        f"""\
        #!/usr/bin/env bash
        set -Eeuo pipefail
        umask 022

        build_root={shell_quote(build_root)}
        component_build_id={shell_quote(component_build_id)}
        archive_name={shell_quote(archive_name)}
        lock_digest={shell_quote(lock.digest)}
        mcp_version={shell_quote(lock.mcp.version)}
        mcp_upstream_commit={shell_quote(lock.mcp.upstream_commit)}
        mcp_build_commit={shell_quote(lock.mcp.commit)}

        for command in flock python3 tar zstd cmp sha256sum; do
          command -v "$command" >/dev/null
        done
        mkdir -p "$build_root/out"
        exec 9>"$build_root/.package.lock"
        flock -x 9
        build_directory="$build_root/builds/$component_build_id"
        runtime="$build_directory/runtime"
        build_manifest="$build_directory/build-manifest.json"
        archive="$build_root/out/$archive_name"
        temporary_archive="$build_root/out/.$archive_name-new"
        archive_digest="$archive.sha256"
        temporary_digest="$build_root/out/.$archive_name.sha256-new"
        release_identity="$build_root/out/release-$component_build_id.id"
        temporary_identity="$build_root/out/.release-$component_build_id.id-new"
        rm -rf -- "$temporary_archive" "$temporary_digest" "$temporary_identity"

        read -r source_date_epoch package_mode release_build_id <<< "$(
          python3 - "$runtime" "$build_manifest" "$build_root/out" \
            "$component_build_id" "$lock_digest" "$mcp_version" \
            "$mcp_upstream_commit" "$mcp_build_commit" <<'PY'
import hashlib
import json
import os
import pathlib
import shutil
import stat
import sys

runtime, build_manifest, output_root, component_id, lock_digest, version, upstream, build_commit = sys.argv[1:]
runtime, build_manifest, output_root = map(pathlib.Path, (runtime, build_manifest, output_root))
hex_characters = frozenset('0123456789abcdef')

def fail(message):
    raise SystemExit(f'remote MCP package verification failed: {{message}}')

def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()

def inspect(root, *, release=False):
    if root.is_symlink() or not root.is_dir():
        fail('runtime is not a real directory')
    files, directories = {{}}, []
    for current, names, file_names in os.walk(root, followlinks=False):
        names.sort(); file_names.sort(); current_path = pathlib.Path(current)
        for name in names:
            path = current_path / name; relative = path.relative_to(root).as_posix()
            if path.is_symlink() or not stat.S_ISDIR(path.lstat().st_mode):
                fail(f'runtime has an unsupported directory: {{relative}}')
            directories.append(relative)
        for name in file_names:
            path = current_path / name; relative = path.relative_to(root).as_posix(); status = path.lstat()
            if path.is_symlink() or not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
                fail(f'runtime has an unsupported file: {{relative}}')
            files[relative] = digest(path)
    runtime_files = {{key: value for key, value in files.items() if not release or key not in {{'manifest.json', 'SHA256SUMS'}}}}
    roots = {{pathlib.PurePosixPath(key).parts[0] for key in (*runtime_files, *directories)}}
    if roots != {{'mcp'}} or 'mcp/bin/chrome-devtools-mcp.js' not in runtime_files:
        fail('runtime must contain only the required MCP files')
    return dict(sorted(files.items())), sorted(directories)

def checksum_payload(root, runtime_files):
    return b''.join(
        digest(root / relative).encode('ascii') + b'  ' + relative.encode('utf-8') + b'\\0'
        for relative in sorted([*runtime_files, 'manifest.json'])
    )

try:
    build = json.loads(build_manifest.read_text(encoding='utf-8'))
except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
    fail(f'build manifest is invalid: {{error}}')
keys = {{'schema', 'build_id', 'lock_digest', 'source_date_epoch', 'versions', 'provenance', 'files', 'directories'}}
expected = {{
    'schema': {BUILD_SCHEMA}, 'build_id': component_id, 'lock_digest': lock_digest,
    'versions': {{'chrome_devtools_mcp': version}},
    'provenance': {{'chrome_devtools_mcp': {{'upstream_commit': upstream, 'build_commit': build_commit}}}},
}}
if not isinstance(build, dict) or set(build) != keys or any(build.get(key) != value for key, value in expected.items()):
    fail('build manifest does not match the requested MCP lock')
if not isinstance(build.get('source_date_epoch'), int) or isinstance(build['source_date_epoch'], bool) or build['source_date_epoch'] <= 0:
    fail('build source date is invalid')
files, directories = inspect(runtime)
if build.get('files') != files or build.get('directories') != directories:
    fail('runtime does not match the verified build inventory')
serialized = json.dumps({{'files': files, 'directories': directories}}, separators=(',', ':'), sort_keys=True)
release_id = hashlib.sha256(f'mcp-release-v{PACKAGE_SCHEMA}\\0{{component_id}}\\0{{serialized}}'.encode()).hexdigest()[:24]
manifest = {{
    'schema': {PACKAGE_SCHEMA}, 'build_id': release_id, 'component_build_id': component_id,
    'lock_digest': lock_digest, 'versions': build['versions'], 'provenance': build['provenance'],
    'files': files, 'directories': directories,
}}
release = output_root / f'release-{{release_id}}'
temporary = output_root / f'.release-{{release_id}}-new' / f'release-{{release_id}}'
temporary_parent = temporary.parent
if temporary_parent.is_symlink() or (temporary_parent.exists() and not temporary_parent.is_dir()):
    fail('temporary release path is invalid')
if temporary_parent.is_dir():
    shutil.rmtree(temporary_parent)
if release.exists() or release.is_symlink():
    existing_files, existing_directories = inspect(release, release=True)
    try:
        existing = json.loads((release / 'manifest.json').read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
        fail(f'existing release manifest is invalid: {{error}}')
    try:
        actual_checksums = (release / 'SHA256SUMS').read_bytes()
    except OSError as error:
        fail(f'existing release checksums are invalid: {{error}}')
    if existing != manifest or existing_files != {{**files, 'manifest.json': digest(release / 'manifest.json'), 'SHA256SUMS': digest(release / 'SHA256SUMS')}} or existing_directories != directories or actual_checksums != checksum_payload(release, files):
        fail('existing release differs from the requested release')
    print(build['source_date_epoch'], 'reuse', release_id)
    raise SystemExit(0)
try:
    shutil.copytree(runtime, temporary, copy_function=shutil.copy2)
    (temporary / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\\n', encoding='utf-8')
    (temporary / 'SHA256SUMS').write_bytes(checksum_payload(temporary, files))
except BaseException:
    shutil.rmtree(temporary_parent, ignore_errors=True)
    raise
print(build['source_date_epoch'], 'create', release_id)
PY
        )"

        release_directory="$build_root/out/release-$release_build_id"
        temporary_parent="$build_root/out/.release-$release_build_id-new"
        temporary_release="$temporary_parent/release-$release_build_id"
        test "$source_date_epoch" -gt 0
        if test -e "$archive" || test -L "$archive"; then
          test "$package_mode" = reuse
          test -f "$archive" && test ! -L "$archive"
          tar --sort=name --format=gnu --mtime="@$source_date_epoch" --owner=0 --group=0 --numeric-owner -C "$(dirname "$release_directory")" -cf - "$(basename "$release_directory")" | zstd --threads=1 --quiet --force -o "$temporary_archive"
          cmp --silent "$temporary_archive" "$archive"
          rm -f -- "$temporary_archive"
        else
          if test "$package_mode" = create; then
            archive_parent="$temporary_parent"
            archive_release="$(basename "$temporary_release")"
          else
            archive_parent="$(dirname "$release_directory")"
            archive_release="$(basename "$release_directory")"
          fi
          tar --sort=name --format=gnu --mtime="@$source_date_epoch" --owner=0 --group=0 --numeric-owner -C "$archive_parent" -cf - "$archive_release" | zstd --threads=1 --quiet --force -o "$temporary_archive"
          if test "$package_mode" = create; then
            mv -- "$temporary_release" "$release_directory"
            rmdir "$temporary_parent"
          fi
          mv -- "$temporary_archive" "$archive"
        fi
        sha256sum -- "$archive" | {{ read -r digest _; printf '%s\n' "$digest"; }} > "$temporary_digest"
        if test -e "$archive_digest" || test -L "$archive_digest"; then
          test -f "$archive_digest" && test ! -L "$archive_digest"
          cmp --silent "$temporary_digest" "$archive_digest"
          rm -f -- "$temporary_digest"
        else
          mv -- "$temporary_digest" "$archive_digest"
        fi
        printf '%s\n' "$release_build_id" > "$temporary_identity"
        if test -e "$release_identity" || test -L "$release_identity"; then
          test -f "$release_identity" && test ! -L "$release_identity"
          cmp --silent "$temporary_identity" "$release_identity"
          rm -f -- "$temporary_identity"
        else
          mv -- "$temporary_identity" "$release_identity"
        fi
        """
    )
