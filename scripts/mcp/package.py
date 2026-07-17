#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import logging
import os
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from mcp._archive import archive_digest_path, sha256
    from mcp._common import (
        WorkflowError,
        cli_main,
        exclusive_lock,
        local_build_root,
        repository_root,
        require_commands,
        validate_build_id,
    )
    from mcp._component import read_component
    from mcp._lock import load_lock
    from mcp._package_transaction import (
        JOURNAL_NAME,
        PackageExpectation,
        abort_package_transaction,
        publish_package_outputs,
        recover_package_transaction,
        stage_package_file,
        start_package_transaction,
    )
    from mcp._release import materialize_release
else:
    from ._archive import archive_digest_path, sha256
    from ._common import (
        WorkflowError,
        cli_main,
        exclusive_lock,
        local_build_root,
        repository_root,
        require_commands,
        validate_build_id,
    )
    from ._component import read_component
    from ._lock import load_lock
    from ._package_transaction import (
        JOURNAL_NAME,
        PackageExpectation,
        abort_package_transaction,
        publish_package_outputs,
        recover_package_transaction,
        stage_package_file,
        start_package_transaction,
    )
    from ._release import materialize_release

LOCK_PATH = Path("browser/mcp.lock.json")
LOGGER = logging.getLogger("scriptcat.mcp")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Package one verified local MCP component build.",
        epilog=(
            "Reads only the local verified component, creates a deterministic archive "
            "and SHA-256 sidecar, and never overwrites outputs. Git is used only "
            "to locate the repository root; no network operation is performed. "
            "On success, stdout contains only the release build ID for command "
            "substitution."
            "\n\nExample:\n  uv run --project scripts "
            "--python 3.12 "
            "python scripts/mcp/package.py --build-id 0123456789abcdef01234567"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    result.add_argument(
        "--build-id",
        required=True,
        metavar="COMPONENT_BUILD_ID",
        help="24-character local MCP component build ID",
    )
    result.add_argument(
        "--lock",
        type=Path,
        default=LOCK_PATH,
        help="MCP lock path, relative to the repository root (default: %(default)s)",
    )
    result.add_argument(
        "--build-root",
        type=Path,
        default=local_build_root(),
        help="local component/release root; relative paths use the repository root "
        "(default: %(default)s)",
    )
    result.add_argument(
        "--output",
        type=Path,
        help="new archive path; relative paths use the repository root "
        "(default: /tmp/scriptcat-mcp-<component-build-id>.tar.zst)",
    )
    result.add_argument(
        "--sha256-output",
        type=Path,
        help="new SHA-256 sidecar path; relative paths use the repository root "
        "(default: <output>.sha256)",
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    validate_build_id(arguments.build_id, "--build-id")
    require_commands("tar", "zstd")
    root = repository_root()
    lock = load_lock(resolve(root, arguments.lock))
    build_root = resolve(root, arguments.build_root)
    output = resolve_output(root, arguments.output, arguments.build_id)
    digest_output = (
        resolve(root, arguments.sha256_output)
        if arguments.sha256_output
        else archive_digest_path(output)
    )
    output = canonical_output(output)
    digest_output = canonical_output(digest_output)
    with exclusive_lock(build_root, ".package.lock"):
        component_path = build_root / "builds" / arguments.build_id
        component = read_component(component_path, lock)
        release, release_id = materialize_release(
            component_path, component, build_root / "releases"
        )
        expected = PackageExpectation(
            component_build_id=arguments.build_id,
            release_build_id=release_id,
            archive=output,
            digest=digest_output,
        )
        journal_path = build_root / JOURNAL_NAME
        if recover_package_transaction(journal_path, expected):
            LOGGER.info("recovered completed MCP archive transaction: %s", output)
            print(release_id)
            return 0
        ensure_outputs_available(output, digest_output)
        create_archive(
            release,
            component.source_date_epoch,
            output,
            digest_output,
            journal_path,
            arguments.build_id,
            release_id,
        )
    LOGGER.info("created MCP archive: %s", output)
    LOGGER.info("MCP archive SHA-256: %s", sha256(output))
    print(release_id)
    return 0


def create_archive(
    release: Path,
    epoch: int,
    output: Path,
    digest_output: Path,
    journal_path: Path,
    component_build_id: str,
    release_build_id: str,
) -> None:
    expected = PackageExpectation(
        component_build_id=component_build_id,
        release_build_id=release_build_id,
        archive=output,
        digest=digest_output,
    )
    journal = start_package_transaction(journal_path, expected)
    try:
        journal, tar_path = stage_package_file(journal_path, journal, output, ".tar")
        journal, archive_path = stage_package_file(
            journal_path, journal, output, ".tar.zst"
        )
        journal, digest_path = stage_package_file(
            journal_path, journal, digest_output, ".sha256"
        )
        write_command_output(
            (
                "tar",
                "--sort=name",
                "--format=gnu",
                f"--mtime=@{epoch}",
                "--owner=0",
                "--group=0",
                "--numeric-owner",
                "-C",
                str(release.parent),
                "-cf",
                "-",
                release.name,
            ),
            tar_path,
            "create MCP release tar",
        )
        write_command_output(
            (
                "zstd",
                "--threads=1",
                "--quiet",
                "--stdout",
                str(tar_path),
            ),
            archive_path,
            "compress MCP release archive",
        )
        with digest_path.open("w", encoding="ascii") as stream:
            stream.write(sha256(archive_path) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
    except Exception as error:
        try:
            abort_package_transaction(journal_path, expected)
        except WorkflowError as cleanup_error:
            raise WorkflowError(
                f"cannot create MCP package: {error}; cleanup failed: {cleanup_error}"
            ) from error
        if isinstance(error, WorkflowError):
            raise error
        raise WorkflowError(f"cannot create MCP package: {error}") from error
    publish_package_outputs(journal_path, journal, archive_path, digest_path)


def write_command_output(
    command: tuple[str, ...], output: Path, operation: str
) -> None:
    try:
        with output.open("wb") as stream:
            subprocess.run(command, check=True, stdout=stream)
            stream.flush()
            os.fsync(stream.fileno())
    except (OSError, subprocess.CalledProcessError) as error:
        raise WorkflowError(f"cannot {operation}: {error}") from error


def ensure_outputs_available(output: Path, digest_output: Path) -> None:
    if output.absolute() == digest_output.absolute():
        raise WorkflowError("archive and SHA-256 outputs must be different")
    for label, path in (("archive", output), ("SHA-256 sidecar", digest_output)):
        if not path.parent.is_dir() or path.parent.is_symlink():
            raise WorkflowError(f"{label} output parent is not a real directory")
        if path.exists() or path.is_symlink():
            raise WorkflowError(f"refusing to overwrite existing {label}: {path}")


def canonical_output(path: Path) -> Path:
    if not path.parent.is_dir() or path.parent.is_symlink():
        raise WorkflowError(f"output parent is not a real directory: {path.parent}")
    try:
        return path.parent.resolve(strict=True) / path.name
    except OSError as error:
        raise WorkflowError(f"cannot resolve output parent: {path.parent}") from error


def resolve_output(root: Path, argument: Path | None, component_id: str) -> Path:
    if argument is None:
        return Path("/tmp") / f"scriptcat-mcp-{component_id}.tar.zst"
    return resolve(root, argument)


def resolve(root: Path, path: Path) -> Path:
    expanded = path.expanduser()
    return expanded if expanded.is_absolute() else root / expanded


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
