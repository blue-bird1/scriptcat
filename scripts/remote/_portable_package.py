from __future__ import annotations

import re
import textwrap

from ._common import (
    REMOTE_BUILD_ROOT,
    WorkflowError,
    shell_quote,
    validate_build_id,
)
from ._lock import UpstreamLock

_ARCHIVE_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.zst")


def portable_package_script(
    archive_name: str,
    lock: UpstreamLock,
    *,
    component_build_id: str,
    release_build_id: str,
    build_root: str = REMOTE_BUILD_ROOT,
) -> str:
    """Generate the self-contained remote packaging program for a verified build."""
    validate_build_id(component_build_id, "component build ID")
    validate_build_id(release_build_id, "release build ID")
    if not _ARCHIVE_NAME_PATTERN.fullmatch(archive_name):
        raise WorkflowError(f"archive name is unsafe or unsupported: {archive_name!r}")

    return textwrap.dedent(
        f"""\
        #!/usr/bin/env bash
        set -Eeuo pipefail
        umask 022

        build_root={shell_quote(build_root)}
        component_build_id={shell_quote(component_build_id)}
        release_build_id={shell_quote(release_build_id)}
        archive_name={shell_quote(archive_name)}
        lock_digest={shell_quote(lock.digest)}
        chromium_version={shell_quote(lock.chromium.version)}
        mcp_version={shell_quote(lock.mcp.version)}
        depot_tools_version={shell_quote(lock.depot_tools.version)}
        scriptcat_version={shell_quote(lock.scriptcat.version)}

        fail_phase=initialize
        report_failure() {{
          local status=$?
          trap - ERR
          printf 'remote package phase failed: %s\\n' "$fail_phase" >&2
          exit "$status"
        }}
        trap report_failure ERR

        command -v flock >/dev/null
        command -v python3 >/dev/null
        command -v tar >/dev/null
        command -v zstd >/dev/null
        command -v cmp >/dev/null
        mkdir -p "$build_root/out"
        exec 9>"$build_root/.package.lock"
        printf 'waiting for remote package lock: %s\\n' "$build_root/.package.lock"
        flock -x 9
        printf 'acquired remote package lock: %s\\n' "$build_root/.package.lock"

        build_directory="$build_root/builds/$component_build_id"
        runtime="$build_directory/runtime"
        build_manifest="$build_directory/build-manifest.json"
        release_directory="$build_root/out/release-$release_build_id"
        release_temporary_parent="$build_root/out/.release-$release_build_id-new"
        release_temporary="$release_temporary_parent/release-$release_build_id"
        archive="$build_root/out/$archive_name"
        archive_temporary="$build_root/out/.$archive_name-new"

        release_exists=false
        archive_exists=false
        if test -e "$release_directory" || test -L "$release_directory"; then
          release_exists=true
        fi
        if test -e "$archive" || test -L "$archive"; then
          archive_exists=true
        fi
        if test "$archive_exists" = true && test "$release_exists" != true; then
          printf 'remote archive exists without its immutable release: %s\n' \
            "$archive" >&2
          exit 1
        fi
        rm -rf -- "$release_temporary_parent" "$archive_temporary"

        fail_phase=verify-and-assemble
        read -r source_date_epoch package_mode <<< "$(
          python3 - "$runtime" "$build_manifest" "$release_directory" \\
            "$release_temporary" "$release_build_id" "$component_build_id" \\
            "$lock_digest" \\
            "$chromium_version" "$mcp_version" "$depot_tools_version" \\
            "$scriptcat_version" <<'PY'
import hashlib
import json
import os
import pathlib
import shutil
import stat
import sys

RUNTIME_REQUIRED_FILES = {{
    "chromium/chrome-linux/chrome",
    "mcp/bin/chrome-devtools-mcp.js",
    "scriptcat/manifest.json",
}}
BUILD_MANIFEST_KEYS = {{
    "schema",
    "build_id",
    "project_commit",
    "lock_digest",
    "source_date_epoch",
    "chromium_version",
    "mcp_version",
    "depot_tools_version",
    "scriptcat_version",
    "files",
    "directories",
}}
RELEASE_RESERVED_FILES = {{"manifest.json", "SHA256SUMS"}}
RELEASE_MANIFEST_KEYS = {{
    "build_id",
    "chromium_version",
    "mcp_version",
    "depot_tools_version",
    "scriptcat_version",
    "files",
    "directories",
}}


def fail(message):
    raise SystemExit(f"remote package verification failed: {{message}}")


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_relative_path(value, context):
    if not isinstance(value, str) or not value:
        fail(f"{{context}} is not a non-empty string")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        fail(f"{{context}} is not UTF-8 encodable")
    path = pathlib.PurePosixPath(value)
    if (
        path.is_absolute()
        or path == pathlib.PurePosixPath(".")
        or ".." in path.parts
        or path.as_posix() != value
    ):
        fail(f"{{context}} is unsafe or non-canonical")
    return path


def is_sha256(value):
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def inspect_tree(root):
    try:
        root_status = root.lstat()
    except FileNotFoundError:
        fail(f"runtime is missing: {{root}}")
    if not stat.S_ISDIR(root_status.st_mode) or root.is_symlink():
        fail("runtime is not a real directory")
    files = {{}}
    directories = []
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        directory_names.sort()
        file_names.sort()
        current_path = pathlib.Path(current)
        for name in directory_names:
            path = current_path / name
            status = path.lstat()
            relative = path.relative_to(root).as_posix()
            canonical_relative_path(relative, "runtime directory")
            if not stat.S_ISDIR(status.st_mode):
                fail(f"runtime contains an unsupported entry: {{relative}}")
            directories.append(relative)
        for name in file_names:
            path = current_path / name
            status = path.lstat()
            relative = path.relative_to(root).as_posix()
            canonical_relative_path(relative, "runtime file")
            if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
                fail(f"runtime contains an unsupported entry: {{relative}}")
            files[relative] = digest_file(path)
    return dict(sorted(files.items())), sorted(directories)


def read_build_manifest(path, expected):
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError) as error:
        fail(f"build manifest is invalid: {{error}}")
    if not isinstance(raw, dict) or set(raw) != BUILD_MANIFEST_KEYS:
        fail("build manifest has an unsupported shape")
    if raw["schema"] != 1:
        fail("build manifest schema must be 1")
    for key in (
        "build_id",
        "project_commit",
        "lock_digest",
        "chromium_version",
        "mcp_version",
        "depot_tools_version",
        "scriptcat_version",
    ):
        if not isinstance(raw[key], str) or not raw[key]:
            fail(f"build manifest {{key}} is invalid")
    if (
        len(raw["project_commit"]) != 40
        or not all(
            character in "0123456789abcdef"
            for character in raw["project_commit"]
        )
    ):
        fail("build manifest project_commit is invalid")
    if not isinstance(raw["source_date_epoch"], int) or isinstance(
        raw["source_date_epoch"], bool
    ) or raw["source_date_epoch"] <= 0:
        fail("build manifest source_date_epoch is invalid")
    for key, value in expected.items():
        if raw[key] != value:
            fail(f"build manifest {{key}} does not match the requested package")
    files = raw["files"]
    directories = raw["directories"]
    if (
        not isinstance(files, dict)
        or list(files) != sorted(files)
        or not isinstance(directories, list)
        or directories != sorted(set(directories))
    ):
        fail("build manifest runtime inventory is invalid")
    for relative, digest in files.items():
        canonical_relative_path(relative, "build manifest file")
        if not is_sha256(digest):
            fail("build manifest file checksum is invalid")
    for relative in directories:
        canonical_relative_path(relative, "build manifest directory")
    return raw


def write_release_manifest(root, release_build_id, versions):
    files, directories = inspect_tree(root)
    if RELEASE_RESERVED_FILES & set(files):
        fail("runtime reserves a release metadata filename")
    release_manifest = {{
        "build_id": release_build_id,
        "chromium_version": versions["chromium_version"],
        "mcp_version": versions["mcp_version"],
        "depot_tools_version": versions["depot_tools_version"],
        "scriptcat_version": versions["scriptcat_version"],
        "files": files,
        "directories": directories,
    }}
    manifest_path = root / "manifest.json"
    manifest_path.write_text(
        json.dumps(release_manifest, indent=2, sort_keys=True) + "\\n",
        encoding="utf-8",
    )
    with (root / "SHA256SUMS").open("wb") as stream:
        for relative in sorted([*files, "manifest.json"]):
            digest = digest_file(root / relative).encode("ascii")
            stream.write(digest + b"  " + relative.encode("utf-8") + b"\\0")


def read_release_manifest(path, expected):
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError) as error:
        fail(f"release manifest is invalid: {{error}}")
    if not isinstance(raw, dict) or set(raw) != RELEASE_MANIFEST_KEYS:
        fail("release manifest has an unsupported shape")
    for key, value in expected.items():
        if raw[key] != value:
            fail(f"release manifest {{key}} does not match the requested package")
    files = raw["files"]
    directories = raw["directories"]
    if (
        not isinstance(files, dict)
        or list(files) != sorted(files)
        or not isinstance(directories, list)
        or directories != sorted(set(directories))
    ):
        fail("release manifest runtime inventory is invalid")
    for relative, digest in files.items():
        canonical_relative_path(relative, "release manifest file")
        if not is_sha256(digest):
            fail("release manifest file checksum is invalid")
    for relative in directories:
        canonical_relative_path(relative, "release manifest directory")
    return raw


def verify_release(root, release_build_id, build_manifest, runtime_files, runtime_dirs):
    try:
        status = root.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(status.st_mode) or root.is_symlink():
        fail("existing release is not a real directory")
    release_manifest = read_release_manifest(
        root / "manifest.json",
        {{
            "build_id": release_build_id,
            "chromium_version": build_manifest["chromium_version"],
            "mcp_version": build_manifest["mcp_version"],
            "depot_tools_version": build_manifest["depot_tools_version"],
            "scriptcat_version": build_manifest["scriptcat_version"],
            "files": runtime_files,
            "directories": runtime_dirs,
        }},
    )
    files, directories = inspect_tree(root)
    if set(files) != set(runtime_files) | RELEASE_RESERVED_FILES:
        fail("release manifest does not cover the exact release tree")
    if directories != runtime_dirs:
        fail("release manifest does not cover the exact release tree")
    if {{relative: files[relative] for relative in runtime_files}} != runtime_files:
        fail("release files do not match the verified build manifest")
    manifest_digest = digest_file(root / "manifest.json")
    expected_sums = b"".join(
        digest_file(root / relative).encode("ascii")
        + b"  "
        + relative.encode("utf-8")
        + b"\\0"
        for relative in sorted([*runtime_files, "manifest.json"])
    )
    if (root / "SHA256SUMS").read_bytes() != expected_sums:
        fail("SHA256SUMS is invalid or does not match the release")
    if files["manifest.json"] != manifest_digest:
        fail("release manifest checksum is invalid")
    if release_manifest["files"] != runtime_files:
        fail("release manifest files do not match the verified build manifest")
    return True


runtime = pathlib.Path(sys.argv[1])
build_manifest_path = pathlib.Path(sys.argv[2])
release_directory = pathlib.Path(sys.argv[3])
release_temporary = pathlib.Path(sys.argv[4])
expected = {{
    "build_id": sys.argv[6],
    "lock_digest": sys.argv[7],
    "chromium_version": sys.argv[8],
    "mcp_version": sys.argv[9],
    "depot_tools_version": sys.argv[10],
    "scriptcat_version": sys.argv[11],
}}
build_manifest = read_build_manifest(build_manifest_path, expected)
files, directories = inspect_tree(runtime)
if files != build_manifest["files"] or directories != build_manifest["directories"]:
    fail("runtime does not match the verified build manifest inventory")
if not RUNTIME_REQUIRED_FILES.issubset(files):
    fail("build manifest omits required portable runtime files")
if verify_release(release_directory, sys.argv[5], build_manifest, files, directories):
    print(build_manifest["source_date_epoch"], "reuse")
    raise SystemExit(0)
if release_temporary.exists() or release_temporary.is_symlink():
    fail(f"temporary release path already exists: {{release_temporary}}")
try:
    shutil.copytree(runtime, release_temporary, copy_function=shutil.copy2)
    copied_files, copied_directories = inspect_tree(release_temporary)
    if copied_files != files or copied_directories != directories:
        fail("copied runtime differs from the verified runtime")
    write_release_manifest(release_temporary, sys.argv[5], build_manifest)
except BaseException:
    shutil.rmtree(release_temporary, ignore_errors=True)
    raise
print(build_manifest["source_date_epoch"], "create")
PY
        )"
        test "$source_date_epoch" -gt 0

        if test -e "$archive" || test -L "$archive"; then
          test "$package_mode" = reuse
          test -f "$archive"
          test ! -L "$archive"
          fail_phase=verify-existing-archive
          tar --sort=name --format=gnu --mtime="@$source_date_epoch" \\
            --owner=0 --group=0 --numeric-owner -C "$(dirname "$release_directory")" \\
            -cf - "$(basename "$release_directory")" | \\
            zstd --threads=1 --quiet --force -o "$archive_temporary"
          cmp --silent "$archive_temporary" "$archive"
          rm -f -- "$archive_temporary"
          printf 'remote package completed: release=%s archive=%s\\n' \\
            "$release_build_id" "$archive"
          exit 0
        fi

        fail_phase=archive
        if test "$package_mode" = create; then
          archive_parent="$release_temporary_parent"
          archive_release="$(basename "$release_temporary")"
        else
          archive_parent="$(dirname "$release_directory")"
          archive_release="$(basename "$release_directory")"
        fi
        tar --sort=name --format=gnu --mtime="@$source_date_epoch" \\
          --owner=0 --group=0 --numeric-owner -C "$archive_parent" \\
          -cf - "$archive_release" | \\
          zstd --threads=1 --quiet --force -o "$archive_temporary"
        if test "$package_mode" = create; then
          mv -- "$release_temporary" "$release_directory"
          rmdir "$release_temporary_parent"
        fi
        mv -- "$archive_temporary" "$archive"
        printf 'remote package completed: release=%s archive=%s\\n' \\
          "$release_build_id" "$archive"
        """
    )
