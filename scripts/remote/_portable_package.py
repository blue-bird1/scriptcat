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
        scriptcat_version={shell_quote(lock.scriptcat.version)}
        mcp_upstream_commit={shell_quote(lock.mcp.upstream_commit)}
        mcp_build_commit={shell_quote(lock.mcp.commit)}
        scriptcat_upstream_commit={shell_quote(lock.scriptcat.commit)}
        scriptcat_patch_digest={shell_quote(lock.patch_digest("scriptcat"))}

        phase=initialize
        report_failure() {{
          local status=$?
          trap - ERR
          printf 'remote MCP package phase failed: %s\n' "$phase" >&2
          exit "$status"
        }}
        trap report_failure ERR

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

        phase=verify-and-assemble
        read -r source_date_epoch package_mode release_build_id <<< "$(
          python3 - "$runtime" "$build_manifest" "$build_root/out" \
            "$component_build_id" "$lock_digest" "$mcp_version" \
            "$scriptcat_version" "$mcp_upstream_commit" "$mcp_build_commit" \
            "$scriptcat_upstream_commit" "$scriptcat_patch_digest" <<'PY'
import hashlib
import json
import os
import pathlib
import shutil
import stat
import sys

BUILD_KEYS = {{
    'schema', 'build_id', 'lock_digest', 'source_date_epoch',
    'versions', 'provenance', 'files', 'directories',
}}
RELEASE_KEYS = {{
    'schema', 'build_id', 'component_build_id', 'lock_digest',
    'versions', 'provenance', 'files', 'directories',
}}
BUILD_SCHEMA = {BUILD_SCHEMA}
PACKAGE_SCHEMA = {PACKAGE_SCHEMA}
RUNTIME_ROOTS = frozenset({{'mcp', 'scriptcat'}})
REQUIRED_FILES = frozenset({{'mcp/bin/chrome-devtools-mcp.js', 'scriptcat/manifest.json'}})
RESERVED = frozenset({{'manifest.json', 'SHA256SUMS'}})
HEX = frozenset('0123456789abcdef')


def fail(message):
    raise SystemExit(f'remote MCP package verification failed: {{message}}')


def digest_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def is_hex(value, length):
    return isinstance(value, str) and len(value) == length and all(character in HEX for character in value)


def canonical(value, context):
    if not isinstance(value, str) or not value:
        fail(f'{{context}} is invalid')
    try:
        value.encode('utf-8')
    except UnicodeEncodeError:
        fail(f'{{context}} is not UTF-8 encodable')
    path = pathlib.PurePosixPath(value)
    if path.is_absolute() or path == pathlib.PurePosixPath('.') or '..' in path.parts or path.as_posix() != value:
        fail(f'{{context}} is unsafe or non-canonical')
    return path


def inspect_tree(root, *, release=False):
    try:
        status = root.lstat()
    except FileNotFoundError:
        fail(f'tree is missing: {{root}}')
    if not stat.S_ISDIR(status.st_mode) or root.is_symlink():
        fail(f'tree is not a real directory: {{root}}')
    files = {{}}
    directories = []
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        directory_names.sort()
        file_names.sort()
        current_path = pathlib.Path(current)
        for name in directory_names:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            canonical(relative, 'directory')
            status = path.lstat()
            if not stat.S_ISDIR(status.st_mode) or path.is_symlink():
                fail(f'tree contains an unsupported directory: {{relative}}')
            directories.append(relative)
        for name in file_names:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            canonical(relative, 'file')
            status = path.lstat()
            if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
                fail(f'tree contains an unsupported file: {{relative}}')
            files[relative] = digest_file(path)
    runtime_files = set(files) - RESERVED if release else set(files)
    roots = {{pathlib.PurePosixPath(relative).parts[0] for relative in (*runtime_files, *directories)}}
    if roots != RUNTIME_ROOTS:
        fail(f'runtime roots must be exactly {{sorted(RUNTIME_ROOTS)}}')
    if not REQUIRED_FILES <= runtime_files:
        fail('runtime omits required MCP or ScriptCat files')
    return dict(sorted(files.items())), sorted(directories)


def parse_inventory(raw):
    files = raw.get('files')
    directories = raw.get('directories')
    if not isinstance(files, dict) or list(files) != sorted(files) or not isinstance(directories, list) or directories != sorted(set(directories)):
        fail('manifest inventory has an unsupported shape')
    for relative, digest in files.items():
        canonical(relative, 'manifest file')
        if not is_hex(digest, 64):
            fail('manifest file digest is invalid')
    for relative in directories:
        canonical(relative, 'manifest directory')
    return files, directories


def expected_provenance(arguments, raw):
    value = raw.get('provenance')
    if not isinstance(value, dict) or set(value) != {{'chrome_devtools_mcp', 'scriptcat'}}:
        fail('build provenance has an unsupported shape')
    mcp = value['chrome_devtools_mcp']
    scriptcat = value['scriptcat']
    if mcp != {{'upstream_commit': arguments['mcp_upstream_commit'], 'build_commit': arguments['mcp_build_commit']}}:
        fail('MCP build provenance does not match the lock')
    if not isinstance(scriptcat, dict) or scriptcat.get('upstream_commit') != arguments['scriptcat_upstream_commit'] or scriptcat.get('patch_digest') != arguments['scriptcat_patch_digest'] or set(scriptcat) != {{'upstream_commit', 'patch_digest', 'build_commit'}} or not is_hex(scriptcat.get('build_commit'), 40):
        fail('ScriptCat build provenance does not match the lock')
    return value


def read_build(path, arguments):
    try:
        raw = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
        fail(f'build manifest is invalid: {{error}}')
    if not isinstance(raw, dict) or set(raw) != BUILD_KEYS or raw.get('schema') != BUILD_SCHEMA:
        fail('build manifest has an unsupported shape')
    expected = {{
        'build_id': arguments['component_build_id'],
        'lock_digest': arguments['lock_digest'],
        'versions': {{'chrome_devtools_mcp': arguments['mcp_version'], 'scriptcat': arguments['scriptcat_version']}},
    }}
    for key, value in expected.items():
        if raw.get(key) != value:
            fail(f'build manifest {{key}} does not match the requested package')
    if not isinstance(raw.get('source_date_epoch'), int) or isinstance(raw['source_date_epoch'], bool) or raw['source_date_epoch'] <= 0:
        fail('build manifest source_date_epoch is invalid')
    expected_provenance(arguments, raw)
    parse_inventory(raw)
    return raw


def release_manifest(release_id, build):
    return {{
        'schema': PACKAGE_SCHEMA,
        'build_id': release_id,
        'component_build_id': build['build_id'],
        'lock_digest': build['lock_digest'],
        'versions': build['versions'],
        'provenance': build['provenance'],
        'files': build['files'],
        'directories': build['directories'],
    }}


def write_metadata(root, manifest):
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\\n', encoding='utf-8')
    with (root / 'SHA256SUMS').open('wb') as stream:
        for relative in sorted([*manifest['files'], 'manifest.json']):
            stream.write(digest_file(root / relative).encode('ascii') + b'  ' + relative.encode('utf-8') + b'\\0')


def verify_release(root, expected_manifest):
    if not root.exists():
        return False
    files, directories = inspect_tree(root, release=True)
    try:
        raw = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
        fail(f'existing release manifest is invalid: {{error}}')
    if not isinstance(raw, dict) or set(raw) != RELEASE_KEYS or raw != expected_manifest:
        fail('existing release manifest differs from the requested release')
    if directories != expected_manifest['directories']:
        fail('existing release directory inventory differs from the build')
    runtime_files = {{key: value for key, value in files.items() if key not in RESERVED}}
    if runtime_files != expected_manifest['files']:
        fail('existing release file inventory differs from the build')
    expected_sums = b''.join(
        digest_file(root / relative).encode('ascii') + b'  ' + relative.encode('utf-8') + b'\\0'
        for relative in sorted([*expected_manifest['files'], 'manifest.json'])
    )
    if (root / 'SHA256SUMS').read_bytes() != expected_sums:
        fail('existing release checksum list is invalid')
    return True


runtime = pathlib.Path(sys.argv[1])
build_manifest_path = pathlib.Path(sys.argv[2])
output_root = pathlib.Path(sys.argv[3])
arguments = {{
    'component_build_id': sys.argv[4], 'lock_digest': sys.argv[5],
    'mcp_version': sys.argv[6], 'scriptcat_version': sys.argv[7],
    'mcp_upstream_commit': sys.argv[8], 'mcp_build_commit': sys.argv[9],
    'scriptcat_upstream_commit': sys.argv[10], 'scriptcat_patch_digest': sys.argv[11],
}}
build = read_build(build_manifest_path, arguments)
files, directories = inspect_tree(runtime)
if files != build['files'] or directories != build['directories']:
    fail('runtime does not match the verified build inventory')
serialized_files = json.dumps(files, separators=(',', ':'), sort_keys=True)
release_id = hashlib.sha256(
    f'mcp-release-v{{PACKAGE_SCHEMA}}\\0{{build["build_id"]}}\\0{{serialized_files}}'.encode()
).hexdigest()[:24]
release_directory = output_root / f'release-{{release_id}}'
temporary_release = output_root / f'.release-{{release_id}}-new' / f'release-{{release_id}}'
manifest = release_manifest(release_id, build)
if verify_release(release_directory, manifest):
    print(build['source_date_epoch'], 'reuse', release_id)
    raise SystemExit(0)
if temporary_release.exists() or temporary_release.is_symlink():
    fail(f'temporary release path already exists: {{temporary_release}}')
try:
    shutil.copytree(runtime, temporary_release, copy_function=shutil.copy2)
    copied_files, copied_directories = inspect_tree(temporary_release)
    if copied_files != files or copied_directories != directories:
        fail('copied runtime differs from the verified runtime')
    write_metadata(temporary_release, manifest)
except BaseException:
    shutil.rmtree(temporary_release, ignore_errors=True)
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
          phase=verify-existing-archive
          tar --sort=name --format=gnu --mtime="@$source_date_epoch" \
            --owner=0 --group=0 --numeric-owner -C "$(dirname "$release_directory")" \
            -cf - "$(basename "$release_directory")" | \
            zstd --threads=1 --quiet --force -o "$temporary_archive"
          cmp --silent "$temporary_archive" "$archive"
          rm -f -- "$temporary_archive"
        else
          phase=archive
          if test "$package_mode" = create; then
            archive_parent="$temporary_parent"
            archive_release="$(basename "$temporary_release")"
          else
            archive_parent="$(dirname "$release_directory")"
            archive_release="$(basename "$release_directory")"
          fi
          tar --sort=name --format=gnu --mtime="@$source_date_epoch" \
            --owner=0 --group=0 --numeric-owner -C "$archive_parent" \
            -cf - "$archive_release" | \
            zstd --threads=1 --quiet --force -o "$temporary_archive"
          if test "$package_mode" = create; then
            mv -- "$temporary_release" "$release_directory"
            rmdir "$temporary_parent"
          fi
          mv -- "$temporary_archive" "$archive"
        fi

        phase=archive-digest
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
        printf 'remote MCP package completed: release=%s archive=%s\n' "$release_build_id" "$archive"
        """
    )
