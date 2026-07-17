from __future__ import annotations

import fcntl
import json
import os
import shutil
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .._archive import (
    copy_verified_archive,
    sha256,
    single_release_root,
    unpack_archive,
    verify_checksum_file,
)
from .._common import WorkflowError, validate_build_id
from ._identity import PACKAGE_SCHEMA, release_build_id
from ._lock import ProviderLock

RELEASE_MANIFEST_NAME = "manifest.json"
RELEASE_CHECKSUMS_NAME = "SHA256SUMS"
RELEASE_FIELDS = frozenset(
    {
        "schema",
        "build_id",
        "component_build_id",
        "lock_digest",
        "versions",
        "provenance",
        "files",
        "directories",
    }
)


@dataclass(frozen=True)
class ProviderManifest:
    build_id: str
    files: dict[str, str]
    directories: tuple[str, ...]


def local_data_root() -> Path:
    return Path.home() / ".local" / "share" / "scriptcat-browser"


def activate_archive(
    archive: Path,
    data_root: Path,
    expected_build_id: str,
    archive_sha256: str,
    lock: ProviderLock,
) -> str:
    validate_build_id(expected_build_id, "--build-id")
    staging_root = Path(tempfile.mkdtemp(prefix="scriptcat-browser-stage-", dir="/tmp"))
    try:
        staged_archive = staging_root / "release.tar.zst"
        copy_verified_archive(archive, staged_archive, archive_sha256)
        unpacked = staging_root / "unpacked"
        unpacked.mkdir()
        unpack_archive(staged_archive, unpacked)
        release = single_release_root(unpacked)
        manifest = read_manifest(release, expected_build_id, lock)
        verify_release(release, manifest)
        verify_chromium_binary(release, lock.chromium.version)
        with activation_lock(data_root):
            recover_interrupted_activation(data_root)
            return commit_activation(
                release, manifest, data_root, lock.chromium.version
            )
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)


def read_manifest(
    release: Path, expected_build_id: str, lock: ProviderLock
) -> ProviderManifest:
    try:
        raw = json.loads((release / RELEASE_MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise WorkflowError(
            f"browser provider release manifest is invalid: {error}"
        ) from error
    if not isinstance(raw, dict) or set(raw) != RELEASE_FIELDS:
        raise WorkflowError(
            "browser provider release manifest has an unsupported shape"
        )
    if (
        raw.get("schema") != PACKAGE_SCHEMA
        or raw.get("build_id") != expected_build_id
        or raw.get("lock_digest") != lock.digest
        or raw.get("versions")
        != {"chromium": lock.chromium.version, "depot_tools": lock.depot_tools.version}
    ):
        raise WorkflowError("browser provider release does not match the selected lock")
    component_id = raw.get("component_build_id")
    if not isinstance(component_id, str):
        raise WorkflowError("browser provider release provenance is invalid")
    validate_build_id(component_id, "component build ID")
    expected_provenance = {
        "chromium": {
            "upstream_commit": lock.chromium.commit,
            "patch_digest": lock.chromium_patch.sha256,
        },
        "depot_tools": {"upstream_commit": lock.depot_tools.commit},
    }
    if raw.get("provenance") != expected_provenance:
        raise WorkflowError("browser provider release source provenance is invalid")
    files = _parse_files(raw.get("files"))
    directories = _parse_directories(raw.get("directories"))
    if release_build_id(component_id, files, directories) != expected_build_id:
        raise WorkflowError(
            "browser provider release build ID does not match its runtime inventory"
        )
    return ProviderManifest(
        build_id=expected_build_id, files=files, directories=directories
    )


def verify_release(release: Path, manifest: ProviderManifest) -> None:
    if "chrome-linux/chrome" not in manifest.files:
        raise WorkflowError("browser provider release omits chrome-linux/chrome")
    if any(not relative.startswith("chrome-linux/") for relative in manifest.files):
        raise WorkflowError("browser provider release contains non-browser content")
    actual_files, actual_directories = _release_tree(release)
    expected_files = set(manifest.files) | {
        RELEASE_MANIFEST_NAME,
        RELEASE_CHECKSUMS_NAME,
    }
    if actual_files != expected_files or actual_directories != set(
        manifest.directories
    ):
        raise WorkflowError("browser provider manifest does not cover the release tree")
    for relative, expected_digest in manifest.files.items():
        if sha256(release.joinpath(*PurePosixPath(relative).parts)) != expected_digest:
            raise WorkflowError(f"browser provider checksum mismatch for {relative}")
    covered = verify_checksum_file(release, release / RELEASE_CHECKSUMS_NAME)
    if covered != set(manifest.files) | {RELEASE_MANIFEST_NAME}:
        raise WorkflowError("browser provider checksums do not cover the release")


def verify_chromium_binary(release: Path, chromium_version: str) -> None:
    executable = release / "chrome-linux" / "chrome"
    if not os.access(executable, os.X_OK):
        raise WorkflowError("browser provider Chromium entry is not executable")
    try:
        completed = subprocess.run(
            (str(executable), "--version"),
            check=True,
            text=True,
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise WorkflowError("browser provider Chromium version probe failed") from error
    if chromium_version not in completed.stdout:
        raise WorkflowError("browser provider Chromium reports an unexpected version")


def commit_activation(
    release: Path,
    manifest: ProviderManifest,
    data_root: Path,
    chromium_version: str,
) -> str:
    releases = data_root / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    final = materialize_release(release, manifest, releases, chromium_version)
    current = data_root / "current"
    previous = data_root / "previous"
    current_target = managed_link_target(current, releases)
    if current_target == final:
        return manifest.build_id
    previous_target = managed_link_target(previous, releases)
    write_journal(
        data_root,
        {
            "schema": 1,
            "current": str(current_target) if current_target else None,
            "previous": str(previous_target) if previous_target else None,
        },
    )
    if current_target is not None:
        replace_link(previous, current_target)
    else:
        previous.unlink(missing_ok=True)
    replace_link(current, final)
    (data_root / "activation-journal.json").unlink(missing_ok=True)
    return manifest.build_id


def materialize_release(
    release: Path,
    manifest: ProviderManifest,
    releases: Path,
    chromium_version: str,
) -> Path:
    final = releases / manifest.build_id
    if final.exists() or final.is_symlink():
        if not final.is_dir() or final.is_symlink():
            raise WorkflowError(f"browser provider release path is invalid: {final}")
        verify_release(final, manifest)
        verify_chromium_binary(final, chromium_version)
        return final
    temporary = releases / f".{manifest.build_id}.new"
    if temporary.exists() or temporary.is_symlink():
        raise WorkflowError(
            f"browser provider staging path already exists: {temporary}"
        )
    try:
        shutil.copytree(release, temporary)
        verify_release(temporary, manifest)
        verify_chromium_binary(temporary, chromium_version)
        os.replace(temporary, final)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    return final


@contextmanager
def activation_lock(data_root: Path) -> Iterator[None]:
    data_root.mkdir(parents=True, exist_ok=True)
    with (data_root / "activation.lock").open("a+", encoding="utf-8") as stream:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise WorkflowError(
                "BROWSER_PROVIDER_BUSY: activation is in progress"
            ) from error
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def recover_interrupted_activation(data_root: Path) -> None:
    journal = data_root / "activation-journal.json"
    releases = data_root / "releases"
    _remove_journal_temporary(data_root)
    if not journal.exists():
        _remove_link_temporary(data_root, "current", releases)
        _remove_link_temporary(data_root, "previous", releases)
        return
    try:
        raw = json.loads(journal.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise WorkflowError("browser provider activation journal is invalid") from error
    if not isinstance(raw, dict) or set(raw) != {"schema", "current", "previous"}:
        raise WorkflowError("browser provider activation journal is invalid")
    targets = {
        name: _journal_link_target(raw[name], releases)
        for name in ("current", "previous")
    }
    for name in targets:
        _remove_link_temporary(data_root, name, releases)
    for name in ("current", "previous"):
        target = targets[name]
        if target is None:
            (data_root / name).unlink(missing_ok=True)
        else:
            replace_link(data_root / name, target)
    journal.unlink()


def write_journal(data_root: Path, payload: dict[str, object]) -> None:
    temporary = data_root / ".activation-journal.new"
    if temporary.exists() or temporary.is_symlink():
        raise WorkflowError("browser provider journal temporary path already exists")
    temporary.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, data_root / "activation-journal.json")


def managed_link_target(link: Path, releases: Path) -> Path | None:
    if not link.exists() and not link.is_symlink():
        return None
    if not link.is_symlink():
        raise WorkflowError(f"browser provider link is not a symlink: {link}")
    target = Path(os.readlink(link))
    if not target.is_absolute() or target.parent != releases:
        raise WorkflowError(f"browser provider link is unmanaged: {link}")
    return target


def replace_link(link: Path, target: Path) -> None:
    temporary = link.with_name(f".{link.name}.new")
    if temporary.exists() or temporary.is_symlink():
        raise WorkflowError(f"browser provider link temporary path exists: {temporary}")
    temporary.symlink_to(target)
    os.replace(temporary, link)


def _remove_journal_temporary(data_root: Path) -> None:
    temporary = data_root / ".activation-journal.new"
    if not temporary.exists() and not temporary.is_symlink():
        return
    if temporary.is_symlink() or not temporary.is_file():
        raise WorkflowError("browser provider journal temporary path is invalid")
    temporary.unlink()


def _remove_link_temporary(data_root: Path, name: str, releases: Path) -> None:
    temporary = data_root / f".{name}.new"
    if not temporary.exists() and not temporary.is_symlink():
        return
    if not temporary.is_symlink():
        raise WorkflowError("browser provider link temporary path is invalid")
    target = Path(os.readlink(temporary))
    if not target.is_absolute() or target.parent != releases:
        raise WorkflowError("browser provider link temporary path is unmanaged")
    temporary.unlink()


def _journal_link_target(value: object, releases: Path) -> Path | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise WorkflowError("browser provider activation journal is invalid")
    target = Path(value)
    if not target.is_absolute() or target.parent != releases:
        raise WorkflowError("browser provider activation journal is invalid")
    return target


def _parse_files(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or list(value) != sorted(value):
        raise WorkflowError("browser provider release files are invalid")
    result: dict[str, str] = {}
    for relative, digest in value.items():
        _validate_relative(relative)
        if (
            not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
        ):
            raise WorkflowError("browser provider release file checksum is invalid")
        result[relative] = digest
    return result


def _parse_directories(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or value != sorted(set(value)):
        raise WorkflowError("browser provider release directories are invalid")
    for relative in value:
        _validate_relative(relative)
    return tuple(value)


def _validate_relative(value: object) -> None:
    if not isinstance(value, str):
        raise WorkflowError("browser provider release path is invalid")
    path = PurePosixPath(value)
    if (
        not value
        or path.is_absolute()
        or ".." in path.parts
        or path.as_posix() != value
        or not (value == "chrome-linux" or value.startswith("chrome-linux/"))
    ):
        raise WorkflowError("browser provider release path is invalid")


def _release_tree(release: Path) -> tuple[set[str], set[str]]:
    files: set[str] = set()
    directories: set[str] = set()
    for current, names, file_names in os.walk(release, followlinks=False):
        current_path = Path(current)
        for name in names:
            path = current_path / name
            if path.is_symlink() or not path.is_dir():
                raise WorkflowError("browser provider release has an unsupported entry")
            directories.add(path.relative_to(release).as_posix())
        for name in file_names:
            path = current_path / name
            if path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1:
                raise WorkflowError("browser provider release has an unsupported entry")
            files.add(path.relative_to(release).as_posix())
    return files, directories
