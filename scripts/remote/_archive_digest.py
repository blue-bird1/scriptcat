from __future__ import annotations

import hashlib
from pathlib import Path

from ._common import WorkflowError

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
