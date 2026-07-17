"""Provider-facing exports for shared release archive primitives."""

if __package__.startswith("scripts."):
    from scripts.release_tools.archive import (
        ARCHIVE_DIGEST_SUFFIX,
        archive_digest_path,
        copy_verified_archive,
        read_archive_digest,
        sha256,
        single_release_root,
        unpack_archive,
        validate_sha256_digest,
        verify_checksum_file,
    )
else:
    from release_tools.archive import (
        ARCHIVE_DIGEST_SUFFIX,
        archive_digest_path,
        copy_verified_archive,
        read_archive_digest,
        sha256,
        single_release_root,
        unpack_archive,
        validate_sha256_digest,
        verify_checksum_file,
    )

__all__ = (
    "ARCHIVE_DIGEST_SUFFIX",
    "archive_digest_path",
    "copy_verified_archive",
    "read_archive_digest",
    "sha256",
    "single_release_root",
    "unpack_archive",
    "validate_sha256_digest",
    "verify_checksum_file",
)
