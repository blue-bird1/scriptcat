from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path

from ._archive import sha256
from ._common import WorkflowError

REQUIRED_RUNTIME = "mcp/bin/chrome-devtools-mcp.js"


@dataclass(frozen=True)
class Inventory:
    files: dict[str, str]
    directories: tuple[str, ...]


def inspect_runtime(root: Path) -> Inventory:
    if root.is_symlink() or not root.is_dir():
        raise WorkflowError("MCP runtime is not a real directory")
    files: dict[str, str] = {}
    directories: list[str] = []
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        directory_names.sort()
        file_names.sort()
        current_path = Path(current)
        for name in directory_names:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            if path.is_symlink() or not stat.S_ISDIR(path.lstat().st_mode):
                raise WorkflowError(f"runtime has an unsupported directory: {relative}")
            directories.append(relative)
        for name in file_names:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            status = path.lstat()
            if (
                path.is_symlink()
                or not stat.S_ISREG(status.st_mode)
                or status.st_nlink != 1
            ):
                raise WorkflowError(f"runtime has an unsupported file: {relative}")
            files[relative] = sha256(path)
    roots = {Path(relative).parts[0] for relative in (*files, *directories)}
    if roots != {"mcp"} or REQUIRED_RUNTIME not in files:
        raise WorkflowError("runtime must contain only the required MCP files")
    return Inventory(dict(sorted(files.items())), tuple(sorted(directories)))
