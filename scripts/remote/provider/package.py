#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import os
import secrets
import sys
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from remote.provider import _download_transaction
    from remote.provider._archive import (
        archive_digest_path,
        read_archive_digest,
        sha256,
    )
    from remote.provider._common import (
        WorkflowError,
        cli_main,
        remote_checked,
        repository_root,
        require_clean_main,
        require_commands,
        require_wg0,
        run_checked,
        run_remote_script,
        validate_build_id,
    )
    from remote.provider._lock import load_lock, validate_patch_stack
    from remote.provider._remote import (
        ProviderRemoteConfig,
        remote_component_release_id_command,
        remote_package_script,
    )
else:
    from . import _download_transaction
    from ._archive import archive_digest_path, read_archive_digest, sha256
    from ._common import (
        WorkflowError,
        cli_main,
        remote_checked,
        repository_root,
        require_clean_main,
        require_commands,
        require_wg0,
        run_checked,
        run_remote_script,
        validate_build_id,
    )
    from ._lock import load_lock, validate_patch_stack
    from ._remote import (
        ProviderRemoteConfig,
        remote_component_release_id_command,
        remote_package_script,
    )


LOCK_PATH = Path("browser/provider.lock.json")
ARCHIVE_PREFIX = "scriptcat-browser-provider"
TRANSACTION_TOKEN_BYTES = 16


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Package one verified standalone Chromium provider build.",
        epilog=(
            "Requires a clean, pushed local main branch, wg0, SSH, and rsync. "
            "It neither synchronizes source nor builds Chromium, and downloads a "
            "new archive plus trusted SHA-256 sidecar to /tmp by default.\n\n"
            "Example:\n"
            "  uv run --project scripts --python 3.12 python "
            "scripts/remote/provider/package.py --build-id 0123456789abcdef01234567"
        ),
    )
    result.add_argument(
        "--build-id",
        required=True,
        metavar="COMPONENT_BUILD_ID",
        help="24-character provider component build ID on the remote host",
    )
    result.add_argument(
        "--lock",
        type=Path,
        default=LOCK_PATH,
        help="provider lock relative to the repository root (default: %(default)s)",
    )
    result.add_argument(
        "--output",
        type=Path,
        help="local archive path (default: non-overwriting /tmp path)",
    )
    result.add_argument(
        "--sha256-output",
        type=Path,
        help="local trusted digest path (default: <output>.sha256)",
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    validate_build_id(arguments.build_id, "--build-id")
    require_commands("git", "ip", "ssh", "rsync")
    require_wg0()
    root = repository_root()
    lock = load_lock(root / arguments.lock)
    validate_patch_stack(root, lock)
    require_clean_main(root)
    config = ProviderRemoteConfig()
    release_id = remote_checked(
        config.common(),
        remote_component_release_id_command(config, arguments.build_id),
        capture=True,
    ).stdout.strip()
    validate_build_id(release_id, "remote provider release ID")
    output = _output_path(arguments.output, release_id, root)
    sidecar = _sidecar_path(arguments.sha256_output, output, root)
    _ensure_outputs_available(output, sidecar)
    archive_name = f"{ARCHIVE_PREFIX}-{release_id}.tar.zst"
    run_remote_script(
        config.common(),
        remote_package_script(
            config, lock, arguments.build_id, release_id, archive_name
        ),
    )
    _download(config, archive_name, output, sidecar)
    print(release_id)
    return 0


def _output_path(argument: Path | None, release_id: str, root: Path) -> Path:
    if argument is None:
        return Path("/tmp") / f"{ARCHIVE_PREFIX}-{release_id}.tar.zst"
    return argument.expanduser() if argument.is_absolute() else root / argument


def _sidecar_path(argument: Path | None, archive: Path, root: Path) -> Path:
    if argument is None:
        return archive_digest_path(archive)
    return argument.expanduser() if argument.is_absolute() else root / argument


def _ensure_outputs_available(archive: Path, sidecar: Path) -> None:
    if archive.absolute() == sidecar.absolute():
        raise WorkflowError("archive and SHA-256 output paths must differ")
    for path in (archive, sidecar):
        if not path.parent.is_dir() or path.parent.is_symlink():
            raise WorkflowError(f"output parent is not a real directory: {path.parent}")
    _download_transaction.ensure_available(archive, sidecar)


def _temporary_output(output: Path, token: str) -> Path:
    return output.parent / f".{output.name}.{token}.part"


def _create_transaction_temporaries(archive: Path, sidecar: Path) -> tuple[Path, Path]:
    while True:
        token = secrets.token_hex(TRANSACTION_TOKEN_BYTES)
        archive_temporary = _temporary_output(archive, token)
        sidecar_temporary = _temporary_output(sidecar, token)
        created: list[Path] = []
        try:
            for path in (archive_temporary, sidecar_temporary):
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(descriptor)
                created.append(path)
        except FileExistsError:
            for path in created:
                path.unlink()
            continue
        except BaseException:
            for path in created:
                path.unlink()
            raise
        return archive_temporary, sidecar_temporary


def _download(
    config: ProviderRemoteConfig, archive_name: str, output: Path, sidecar: Path
) -> None:
    with _download_transaction.output_pair_lock(output, sidecar):
        _download_transaction.recover(output, sidecar)
        _download_transaction.ensure_unoccupied(output, sidecar)
        archive_temporary, sidecar_temporary = _create_transaction_temporaries(
            output, sidecar
        )
        journal = _download_transaction.create_journal(
            output, sidecar, archive_temporary, sidecar_temporary
        )
        try:
            remote_base = f"{config.host}:{config.build_root}/out/"
            run_checked(
                (
                    "rsync",
                    "--archive",
                    "--partial",
                    f"{remote_base}{archive_name}",
                    str(archive_temporary),
                )
            )
            run_checked(
                (
                    "rsync",
                    "--archive",
                    "--partial",
                    f"{remote_base}{archive_digest_path(Path(archive_name)).name}",
                    str(sidecar_temporary),
                )
            )
            expected = read_archive_digest(sidecar_temporary)
            if sha256(archive_temporary) != expected:
                raise WorkflowError(
                    "downloaded provider archive does not match SHA-256"
                )
            _fsync_file(archive_temporary)
            _fsync_file(sidecar_temporary)
            os.link(sidecar_temporary, sidecar)
            _fsync_directory(sidecar.parent)
            os.link(archive_temporary, output)
            _fsync_directory(output.parent)
            journal = _download_transaction.mark_archive_complete(journal)
        except FileExistsError as error:
            _download_transaction.abort(journal)
            raise WorkflowError(
                "refusing to overwrite provider download output"
            ) from error
        except BaseException:
            _download_transaction.abort(journal)
            raise
        _download_transaction.finish(journal)


def _fsync_file(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
