from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path

from ._errors import PublishError

RELEASE_SCHEMA_VERSION = 1
COMPONENT_DOMAIN = b"scriptcat-extension-component-v1\0"
RELEASE_DOMAIN = b"scriptcat-extension-release-v1\0"


@dataclass(frozen=True)
class Inventory:
    files: dict[str, str]
    directories: tuple[str, ...]


@dataclass(frozen=True)
class Release:
    component_id: str
    release_id: str
    source_commit: str
    manifest_version: str
    inventory: Inventory

    def payload(self) -> dict[str, object]:
        return {
            "schema_version": RELEASE_SCHEMA_VERSION,
            "component_id": self.component_id,
            "release_id": self.release_id,
            "source_commit": self.source_commit,
            "manifest_version": self.manifest_version,
            "files": self.inventory.files,
            "directories": list(self.inventory.directories),
        }


def component_id(source_commit: str) -> str:
    return hashlib.sha256(COMPONENT_DOMAIN + source_commit.encode()).hexdigest()[:24]


def release_id(component: str, inventory: Inventory) -> str:
    canonical = json.dumps(
        {"files": inventory.files, "directories": inventory.directories},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(RELEASE_DOMAIN + component.encode() + canonical).hexdigest()[
        :24
    ]


def inspect_extension(root: Path) -> Inventory:
    if not root.is_dir() or root.is_symlink():
        raise PublishError(f"extension build output is not a directory: {root}")
    files: dict[str, str] = {}
    directories: list[str] = []
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        current_path = Path(current)
        for name in sorted(directory_names):
            path = current_path / name
            status = path.lstat()
            if not stat.S_ISDIR(status.st_mode) or path.is_symlink():
                raise PublishError(
                    f"extension output contains unsupported entry: {path}"
                )
            directories.append(path.relative_to(root).as_posix())
        for name in sorted(file_names):
            path = current_path / name
            status = path.lstat()
            if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
                raise PublishError(
                    f"extension output contains unsupported entry: {path}"
                )
            files[path.relative_to(root).as_posix()] = sha256_file(path)
    if "manifest.json" not in files:
        raise PublishError("extension build output has no manifest.json")
    return Inventory(dict(sorted(files.items())), tuple(sorted(directories)))


def read_manifest_version(root: Path) -> str:
    try:
        raw = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PublishError(f"cannot read extension manifest: {error}") from error
    version = raw.get("version") if isinstance(raw, dict) else None
    if not isinstance(version, str) or not version:
        raise PublishError("extension manifest version is missing or invalid")
    return version


def create_release(extension: Path, source_commit: str) -> Release:
    inventory = inspect_extension(extension)
    component = component_id(source_commit)
    return Release(
        component_id=component,
        release_id=release_id(component, inventory),
        source_commit=source_commit,
        manifest_version=read_manifest_version(extension),
        inventory=inventory,
    )


def materialize_release(source: Path, release: Release, releases_root: Path) -> Path:
    releases_root.mkdir(parents=True, exist_ok=True)
    final = releases_root / release.release_id
    temporary = releases_root / f".{release.release_id}-publish-new"
    if final.exists() or final.is_symlink():
        verify_release(final, release)
        return final.resolve()
    remove_path(temporary)
    try:
        temporary.mkdir()
        shutil.copytree(source, temporary / "extension")
        write_json(temporary / "release.json", release.payload())
        verify_release(temporary, release)
        fsync_tree(temporary)
        os.replace(temporary, final)
        fsync_directory(releases_root)
    finally:
        remove_path(temporary)
    return final.resolve()


def verify_release(root: Path, expected: Release | None = None) -> Release:
    if not root.is_dir() or root.is_symlink():
        raise PublishError(f"release path is invalid: {root}")
    try:
        entries = {path.name for path in root.iterdir()}
    except OSError as error:
        raise PublishError(f"cannot inspect release path: {error}") from error
    if entries != {"release.json", "extension"}:
        raise PublishError(f"release path contains unexpected entries: {root}")
    try:
        raw = json.loads((root / "release.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PublishError(f"release metadata is invalid: {error}") from error
    release = parse_release(raw)
    inventory = inspect_extension(root / "extension")
    if inventory != release.inventory:
        raise PublishError(f"release content does not match metadata: {root}")
    if (
        release.component_id != component_id(release.source_commit)
        or release.release_id != release_id(release.component_id, inventory)
        or release.manifest_version != read_manifest_version(root / "extension")
    ):
        raise PublishError(f"release identity does not match metadata: {root}")
    if expected is not None and release != expected:
        raise PublishError(
            f"existing release conflicts with release ID {expected.release_id}"
        )
    return release


def parse_release(raw: object) -> Release:
    expected_keys = {
        "schema_version",
        "component_id",
        "release_id",
        "source_commit",
        "manifest_version",
        "files",
        "directories",
    }
    if not isinstance(raw, dict) or set(raw) != expected_keys:
        raise PublishError("release metadata has an unsupported shape")
    files = raw["files"]
    directories = raw["directories"]
    strings = (
        raw["component_id"],
        raw["release_id"],
        raw["source_commit"],
        raw["manifest_version"],
    )
    if (
        raw["schema_version"] != RELEASE_SCHEMA_VERSION
        or not all(isinstance(value, str) and value for value in strings)
        or not isinstance(files, dict)
        or not all(
            isinstance(path, str) and isinstance(digest, str) and len(digest) == 64
            for path, digest in files.items()
        )
        or not isinstance(directories, list)
        or not all(isinstance(path, str) for path in directories)
    ):
        raise PublishError("release metadata has an unsupported shape")
    return Release(
        component_id=raw["component_id"],
        release_id=raw["release_id"],
        source_commit=raw["source_commit"],
        manifest_version=raw["manifest_version"],
        inventory=Inventory(dict(sorted(files.items())), tuple(directories)),
    )


def extension_matches(root: Path, release: Release) -> bool:
    try:
        return inspect_extension(root) == release.inventory
    except PublishError:
        return False


def write_json(path: Path, payload: dict[str, object]) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def fsync_tree(root: Path) -> None:
    directories: list[Path] = []
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        current_path = Path(current)
        directories.append(current_path)
        for name in directory_names:
            path = current_path / name
            if path.is_symlink():
                raise PublishError(f"transaction tree contains a symlink: {path}")
        for name in file_names:
            path = current_path / name
            status = path.lstat()
            if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
                raise PublishError(
                    f"transaction tree contains unsupported entry: {path}"
                )
            with path.open("rb") as stream:
                os.fsync(stream.fileno())
    for directory in reversed(directories):
        fsync_directory(directory)


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def remove_path(path: Path) -> None:
    try:
        status = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISDIR(status.st_mode):
        shutil.rmtree(path)
    else:
        path.unlink()
