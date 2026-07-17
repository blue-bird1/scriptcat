#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from remote._archive import archive_digest_path, read_archive_digest, sha256
    from remote._common import (
        RemoteConfig,
        WorkflowError,
        cli_main,
        repository_root,
        require_commands,
        require_wg0,
        run_checked,
        run_remote_script,
        validate_build_id,
    )
    from remote._lock import load_lock
    from remote._portable_package import portable_package_script
else:
    from .._archive import archive_digest_path, read_archive_digest, sha256
    from .._common import (
        RemoteConfig,
        WorkflowError,
        cli_main,
        repository_root,
        require_commands,
        require_wg0,
        run_checked,
        run_remote_script,
        validate_build_id,
    )
    from .._lock import load_lock
    from .._portable_package import portable_package_script

LOCK_PATH = Path("browser/mcp.lock.json")
ARCHIVE_PREFIX = "scriptcat-mcp"
LOGGER = logging.getLogger("scriptcat.remote")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Package one verified remote MCP component build.",
        epilog=(
            "Requires wg0, SSH, and rsync. It reads only the selected verified MCP "
            "build and does not access Git or another product. "
            "Outputs are non-overwriting.\n\nExample:\n"
            "  uv run --project scripts --python 3.12 python "
            "scripts/remote/mcp/package.py --build-id 0123456789abcdef01234567"
        ),
    )
    result.add_argument(
        "--build-id",
        required=True,
        metavar="COMPONENT_BUILD_ID",
        help="24-character MCP component build ID on the remote host",
    )
    result.add_argument(
        "--lock",
        type=Path,
        default=LOCK_PATH,
        help="MCP lock relative to the repository root (default: %(default)s)",
    )
    result.add_argument(
        "--output",
        type=Path,
        help="new local archive path; defaults to /tmp/scriptcat-mcp-<id>.tar.zst",
    )
    result.add_argument(
        "--sha256-output",
        type=Path,
        help="new archive SHA-256 sidecar; defaults to <archive>.sha256",
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    validate_build_id(arguments.build_id, "--build-id")
    require_commands("git", "ip", "ssh", "rsync")
    require_wg0()
    root = repository_root()
    lock = load_lock(root / arguments.lock)
    output = output_path(arguments.output, arguments.build_id, root)
    digest_output = digest_output_path(arguments.sha256_output, output, root)
    ensure_outputs_available(output, digest_output)
    config = RemoteConfig()
    archive_name = f"{ARCHIVE_PREFIX}-{arguments.build_id}.tar.zst"
    run_remote_script(
        config,
        portable_package_script(
            archive_name,
            lock,
            component_build_id=arguments.build_id,
            build_root=config.build_root,
        ),
    )
    release_id = download_release_id(config, arguments.build_id, output.parent)
    digest = download_archive(config, archive_name, output, digest_output)
    LOGGER.info("downloaded MCP archive: %s", output)
    LOGGER.info("MCP archive SHA-256: %s", digest)
    print(release_id)
    return 0


def output_path(argument: Path | None, component_id: str, root: Path) -> Path:
    if argument is None:
        return Path("/tmp") / f"scriptcat-mcp-{component_id}.tar.zst"
    expanded = argument.expanduser()
    return expanded if expanded.is_absolute() else root / expanded


def digest_output_path(argument: Path | None, output: Path, root: Path) -> Path:
    if argument is None:
        return archive_digest_path(output)
    expanded = argument.expanduser()
    return expanded if expanded.is_absolute() else root / expanded


def ensure_outputs_available(output: Path, digest_output: Path) -> None:
    if output.absolute() == digest_output.absolute():
        raise WorkflowError("archive and SHA-256 outputs must be different")
    for label, path in (("archive", output), ("SHA-256 sidecar", digest_output)):
        if not path.parent.is_dir() or path.parent.is_symlink():
            raise WorkflowError(f"{label} output parent is not a real directory")
        if path.exists() or path.is_symlink():
            raise WorkflowError(f"refusing to overwrite existing {label}: {path}")


def temporary_output(output: Path) -> Path:
    descriptor, temporary_name = tempfile.mkstemp(
        dir=output.parent, prefix=f".{output.name}.", suffix=".part"
    )
    os.close(descriptor)
    return Path(temporary_name)


def download_archive(
    config: RemoteConfig,
    archive_name: str,
    output: Path,
    digest_output: Path,
) -> str:
    archive_temporary = temporary_output(output)
    digest_temporary = temporary_output(digest_output)
    archive_published = False
    try:
        remote_archive = f"{config.host}:{config.build_root}/out/{archive_name}"
        remote_digest = (
            f"{config.host}:{config.build_root}/out/"
            f"{archive_digest_path(Path(archive_name)).name}"
        )
        run_checked(
            ("rsync", "--archive", "--partial", remote_archive, str(archive_temporary))
        )
        run_checked(
            ("rsync", "--archive", "--partial", remote_digest, str(digest_temporary))
        )
        expected = read_archive_digest(digest_temporary)
        if sha256(archive_temporary) != expected:
            raise WorkflowError("downloaded archive does not match its SHA-256 sidecar")
        try:
            os.link(archive_temporary, output)
            archive_published = True
            os.link(digest_temporary, digest_output)
        except FileExistsError as error:
            raise WorkflowError("refusing to overwrite archive output") from error
        return expected
    except BaseException:
        if archive_published:
            try:
                if output.samefile(archive_temporary):
                    output.unlink()
            except FileNotFoundError:
                pass
        raise
    finally:
        archive_temporary.unlink(missing_ok=True)
        digest_temporary.unlink(missing_ok=True)


def download_release_id(
    config: RemoteConfig, component_id: str, destination: Path
) -> str:
    temporary = temporary_output(destination / f"release-{component_id}.id")
    try:
        remote_identity = (
            f"{config.host}:{config.build_root}/out/release-{component_id}.id"
        )
        run_checked(("rsync", "--archive", remote_identity, str(temporary)))
        release_id = temporary.read_text(encoding="ascii").strip()
        validate_build_id(release_id, "remote release build ID")
        return release_id
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
