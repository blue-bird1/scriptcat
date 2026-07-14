#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import hashlib
import logging
import os
import tempfile
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from remote._common import (
        RemoteConfig,
        WorkflowError,
        cli_main,
        repository_root,
        require_clean_main,
        require_commands,
        require_wg0,
        run_checked,
        run_remote_script,
        validate_build_id,
    )
    from remote._lock import load_lock, validate_patch_stacks
    from remote._portable_package import portable_package_script
else:
    from ._common import (
        RemoteConfig,
        WorkflowError,
        cli_main,
        repository_root,
        require_clean_main,
        require_commands,
        require_wg0,
        run_checked,
        run_remote_script,
        validate_build_id,
    )
    from ._lock import load_lock, validate_patch_stacks
    from ._portable_package import portable_package_script


LOCK_PATH = Path("browser/upstreams.lock.json")
ARCHIVE_PREFIX = "scriptcat-mcp-portable"
LOGGER = logging.getLogger("scriptcat.remote")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Package one verified remote ScriptCat MCP component build.",
        epilog=(
            "Requires a clean local main checkout, wg0, SSH, and rsync. It does not "
            "push, synchronize source, build, test, or activate anything. The remote "
            "host verifies build-manifest.json and every runtime file before creating "
            "the archive. The default output is a new, non-overwriting file in /tmp."
        ),
    )
    result.add_argument(
        "--build-id",
        required=True,
        metavar="COMPONENT_BUILD_ID",
        help="24-character component build ID under the remote builds directory",
    )
    result.add_argument(
        "--lock",
        type=Path,
        default=LOCK_PATH,
        help="upstream lock relative to the repository root (default: %(default)s)",
    )
    result.add_argument(
        "--output",
        type=Path,
        help=(
            "new local archive path; defaults to "
            "/tmp/scriptcat-mcp-<release-id>.tar.zst; relative paths resolve from "
            "the repository root"
        ),
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    validate_build_id(arguments.build_id, "--build-id")
    require_commands("git", "ip", "ssh", "rsync")
    require_wg0()
    root = repository_root()
    lock = load_lock(root / arguments.lock)
    validate_patch_stacks(root, lock)
    package_commit = require_clean_main(root)
    release_id = release_build_id(arguments.build_id, package_commit)
    output = output_path(arguments.output, release_id, root)
    ensure_output_available(output)

    config = RemoteConfig()
    archive_name = f"{ARCHIVE_PREFIX}-{release_id}.tar.zst"
    run_remote_script(
        config,
        portable_package_script(
            archive_name,
            lock,
            component_build_id=arguments.build_id,
            release_build_id=release_id,
            build_root=config.build_root,
        ),
    )
    download_archive(config, archive_name, output)
    LOGGER.info("downloaded portable archive: %s", output)
    print(release_id)
    return 0


def release_build_id(component_build_id: str, project_commit: str) -> str:
    validate_build_id(component_build_id, "component build ID")
    if len(project_commit) != 40 or any(
        character not in "0123456789abcdef" for character in project_commit
    ):
        raise WorkflowError("local project commit is not a lowercase 40-hex Git commit")
    source = f"{component_build_id}{project_commit}".encode()
    return hashlib.sha256(source).hexdigest()[:24]


def output_path(argument: Path | None, release_id: str, root: Path) -> Path:
    if argument is None:
        return Path("/tmp") / f"scriptcat-mcp-{release_id}.tar.zst"
    expanded = argument.expanduser()
    return expanded if expanded.is_absolute() else root / expanded


def ensure_output_available(output: Path) -> None:
    parent = output.parent
    if not parent.is_dir() or parent.is_symlink():
        raise WorkflowError(f"archive output parent is not a real directory: {parent}")
    if output.exists() or output.is_symlink():
        raise WorkflowError(f"refusing to overwrite existing archive output: {output}")


def download_archive(config: RemoteConfig, archive_name: str, output: Path) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        dir=output.parent,
        prefix=f".{output.name}.",
        suffix=".part",
    )
    temporary = Path(temporary_name)
    os.close(descriptor)
    remote = f"{config.host}:{config.build_root}/out/{archive_name}"
    try:
        run_checked(("rsync", "--archive", "--partial", remote, str(temporary)))
        try:
            os.link(temporary, output)
        except FileExistsError as error:
            raise WorkflowError(
                f"refusing to overwrite existing archive output: {output}"
            ) from error
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    else:
        temporary.unlink()


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
