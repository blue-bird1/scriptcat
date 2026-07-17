from __future__ import annotations

import hashlib
import shutil
import stat
import subprocess
import tarfile
from pathlib import Path, PurePosixPath

from .common import WorkflowError

ARCHIVE_DIGEST_SUFFIX = ".sha256"


def archive_digest_path(archive: Path) -> Path:
    return Path(f"{archive}{ARCHIVE_DIGEST_SUFFIX}")


def validate_sha256_digest(value: str, label: str) -> None:
    if not is_sha256(value.encode("ascii", errors="ignore")):
        raise WorkflowError(f"{label} must be a lowercase SHA-256 digest")


def read_archive_digest(path: Path) -> str:
    try:
        payload = path.read_bytes()
    except OSError as error:
        raise WorkflowError(f"cannot read archive SHA-256 sidecar: {error}") from error
    if len(payload) != 65 or not payload.endswith(b"\n") or not is_sha256(payload[:-1]):
        raise WorkflowError("archive SHA-256 sidecar is invalid")
    return payload[:-1].decode("ascii")


def copy_verified_archive(
    archive: Path, destination: Path, expected_sha256: str
) -> None:
    validate_sha256_digest(expected_sha256, "expected archive SHA-256")
    digest = hashlib.sha256()
    try:
        with archive.open("rb") as source, destination.open("xb") as output:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
                output.write(chunk)
    except FileNotFoundError as error:
        destination.unlink(missing_ok=True)
        raise WorkflowError(f"release archive is missing: {archive}") from error
    except OSError as error:
        destination.unlink(missing_ok=True)
        raise WorkflowError(f"cannot stage release archive: {error}") from error
    if digest.hexdigest() != expected_sha256:
        destination.unlink()
        raise WorkflowError(
            "release archive SHA-256 does not match the expected digest"
        )


def is_sha256(value: bytes) -> bool:
    return len(value) == 64 and all(
        character in b"0123456789abcdef" for character in value
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def unpack_archive(archive: Path, staging: Path) -> None:
    if not archive.is_file():
        raise WorkflowError(f"release archive is missing: {archive}")
    try:
        process = subprocess.Popen(
            ("zstd", "--decompress", "--stdout", "--", str(archive)),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        raise WorkflowError(f"cannot start archive decompressor: {error}") from error
    assert process.stdout is not None
    assert process.stderr is not None
    directory_modes: list[tuple[Path, int]] = []
    members: set[str] = set()
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as stream:
            for member in stream:
                relative = archive_member_path(member)
                canonical = relative.as_posix()
                if canonical in members:
                    raise WorkflowError(
                        f"release archive contains a duplicate path: {canonical}"
                    )
                members.add(canonical)
                destination = staging.joinpath(*relative.parts)
                if member.type == tarfile.DIRTYPE:
                    destination.mkdir(parents=True, exist_ok=True)
                    if not destination.is_dir() or destination.is_symlink():
                        raise WorkflowError(
                            "release archive path conflicts with a directory: "
                            f"{canonical}"
                        )
                    directory_modes.append((destination, member.mode & 0o777))
                elif member.type in {tarfile.REGTYPE, tarfile.AREGTYPE}:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    extracted = stream.extractfile(member)
                    if extracted is None:
                        raise WorkflowError(
                            f"release archive file cannot be read: {canonical}"
                        )
                    try:
                        with destination.open("xb") as output:
                            shutil.copyfileobj(extracted, output)
                    except FileExistsError as error:
                        raise WorkflowError(
                            f"release archive path conflicts with a file: {canonical}"
                        ) from error
                    finally:
                        extracted.close()
                    destination.chmod(member.mode & 0o777)
                else:
                    raise WorkflowError(
                        f"release archive contains an unsupported entry: {canonical}"
                    )
        for directory, mode in sorted(
            directory_modes, key=lambda item: len(item[0].parts), reverse=True
        ):
            directory.chmod(mode)
    except (OSError, tarfile.TarError, WorkflowError) as error:
        if process.poll() is None:
            process.kill()
        process.communicate()
        if isinstance(error, WorkflowError):
            raise
        raise WorkflowError(f"cannot unpack release archive: {error}") from error
    else:
        stderr = process.stderr.read().decode("utf-8", errors="replace").strip()
        status = process.wait()
        if status != 0:
            detail = stderr or f"zstd exited with status {status}"
            raise WorkflowError(f"cannot unpack release archive: {detail}")
    finally:
        process.stdout.close()
        process.stderr.close()


def archive_member_path(member: tarfile.TarInfo) -> PurePosixPath:
    raw = member.name
    if member.type == tarfile.DIRTYPE and raw.endswith("/"):
        raw = raw[:-1]
    path = canonical_relative_path(raw, "release archive")
    if member.type not in {tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE}:
        raise WorkflowError(
            f"release archive contains an unsupported entry: {path.as_posix()}"
        )
    return path


def canonical_relative_path(relative: str, context: str) -> PurePosixPath:
    path = PurePosixPath(relative)
    if (
        not relative
        or path == PurePosixPath(".")
        or path.is_absolute()
        or ".." in path.parts
        or path.as_posix() != relative
    ):
        raise WorkflowError(f"{context} references an unsafe or non-canonical path")
    return path


def single_release_root(staging: Path) -> Path:
    entries = list(staging.iterdir())
    if len(entries) != 1 or not entries[0].is_dir() or entries[0].is_symlink():
        raise WorkflowError(
            "release archive must contain exactly one top-level directory"
        )
    return entries[0]


def verify_checksum_file(release: Path, sums: Path) -> set[str]:
    try:
        payload = sums.read_bytes()
    except FileNotFoundError as error:
        raise WorkflowError("release omits SHA256SUMS") from error
    if not payload or not payload.endswith(b"\0"):
        raise WorkflowError("SHA256SUMS must be a NUL-terminated checksum list")
    covered: set[str] = set()
    for record in payload[:-1].split(b"\0"):
        if len(record) < 67 or record[64:66] != b"  ":
            raise WorkflowError("SHA256SUMS is invalid or does not match the release")
        expected = record[:64]
        try:
            relative = record[66:].decode("utf-8")
        except UnicodeDecodeError as error:
            raise WorkflowError("SHA256SUMS contains a non-UTF-8 path") from error
        path = canonical_relative_path(relative, "release checksum")
        canonical = path.as_posix()
        target = release.joinpath(*path.parts)
        try:
            status = target.lstat()
        except FileNotFoundError as error:
            raise WorkflowError(
                "SHA256SUMS is invalid or does not match the release"
            ) from error
        if (
            not is_sha256(expected)
            or canonical in covered
            or not stat.S_ISREG(status.st_mode)
            or status.st_nlink != 1
            or sha256(target) != expected.decode("ascii")
        ):
            raise WorkflowError("SHA256SUMS is invalid or does not match the release")
        covered.add(canonical)
    return covered
