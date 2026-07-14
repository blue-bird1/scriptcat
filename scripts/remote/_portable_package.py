# ruff: noqa: E501

from __future__ import annotations

from ._common import shell_quote
from ._lock import UpstreamLock


def portable_package_script(archive_name: str, lock: UpstreamLock) -> str:
    return f"""set_phase portable-package
python3 -   "$runtime"   "$build_id"   {shell_quote(lock.chromium.version)}   {shell_quote(lock.mcp.version)}   {shell_quote(lock.depot_tools.version)}   {shell_quote(lock.scriptcat.version)} <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
files = {{}}
directories = []
reserved = {{'manifest.json', 'SHA256SUMS'}}

def digest_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

for current, directory_names, file_names in os.walk(root, followlinks=False):
    directory_names.sort()
    file_names.sort()
    current_path = pathlib.Path(current)
    for name in directory_names:
        path = current_path / name
        status = path.lstat()
        relative = path.relative_to(root).as_posix()
        relative.encode('utf-8')
        if not stat.S_ISDIR(status.st_mode):
            raise SystemExit(f'portable tree contains an unsupported entry: {{relative}}')
        directories.append(relative)
    for name in file_names:
        path = current_path / name
        status = path.lstat()
        relative = path.relative_to(root).as_posix()
        relative.encode('utf-8')
        if relative in reserved:
            raise SystemExit(f'portable tree contains a reserved file: {{relative}}')
        if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
            raise SystemExit(f'portable tree contains an unsupported entry: {{relative}}')
        files[relative] = digest_file(path)

files = dict(sorted(files.items()))
directories.sort()
(root / 'manifest.json').write_text(
    json.dumps(
        {{
            'build_id': sys.argv[2],
            'chromium_version': sys.argv[3],
            'mcp_version': sys.argv[4],
            'depot_tools_version': sys.argv[5],
            'scriptcat_version': sys.argv[6],
            'files': files,
            'directories': directories,
        }},
        indent=2,
        sort_keys=True,
    )
    + '\\n',
    encoding='utf-8',
)

with (root / 'SHA256SUMS').open('wb') as stream:
    for relative in sorted([*files, 'manifest.json']):
        digest = digest_file(root / relative).encode('ascii')
        stream.write(digest + b'  ' + relative.encode('utf-8') + b'\0')
PY
archive_root="$build_root/out/release-$build_id"
rm -rf "$archive_root"
mv "$runtime" "$archive_root"
archive_temporary="$build_root/out/.{archive_name}-$build_id-new"
rm -f "$archive_temporary"
tar --sort=name --format=gnu --mtime="@$SOURCE_DATE_EPOCH"   --owner=0 --group=0 --numeric-owner -C "$build_root/out"   -cf - "$(basename "$archive_root")" |   zstd --threads=1 --quiet --force -o "$archive_temporary"
mv -f "$archive_temporary" "$build_root/out/{archive_name}"
"""
