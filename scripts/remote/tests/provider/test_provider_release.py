from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path, PurePosixPath

from scripts.remote.provider._lock import load_lock
from scripts.remote.tests.provider._fixtures import (
    archive_sha256,
    create_provider_archive,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
LOCK_SOURCE = REPOSITORY_ROOT / "browser" / "provider.lock.json"
INSTALL_SCRIPT = REPOSITORY_ROOT / "scripts" / "remote" / "provider" / "install.py"
COMPONENT_ID = "fedcba987654321001234567"
MISMATCHED_BUILD_ID = "f" * 24


class BrowserProviderReleaseContractTest(unittest.TestCase):
    def test_archive_contains_only_browser_provider_runtime(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock = load_lock(LOCK_SOURCE)
            archive = create_provider_archive(root, lock, component_id=COMPONENT_ID)
            tar_path = root / "release.tar"
            with tar_path.open("wb") as output:
                subprocess.run(
                    ("zstd", "--decompress", "--stdout", str(archive)),
                    check=True,
                    stdout=output,
                )
            with tarfile.open(tar_path) as archive_stream:
                members = [PurePosixPath(member.name) for member in archive_stream]
            root_name = archive.name.removesuffix(".tar.zst")
            self.assertTrue(members)
            self.assertTrue(
                all(
                    member.parts[0] == root_name
                    and (
                        len(member.parts) == 1
                        or member.parts[1]
                        in {"chrome-linux", "manifest.json", "SHA256SUMS"}
                    )
                    for member in members
                )
            )

    def test_install_leaves_mcp_data_root_untouched(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock_path = root / "provider.lock.json"
            shutil.copyfile(LOCK_SOURCE, lock_path)
            lock = load_lock(lock_path)
            archive = create_provider_archive(root, lock, component_id=COMPONENT_ID)
            build_id = self._archive_build_id(archive)
            home = root / "home"
            sentinel = home / ".local" / "share" / "scriptcat-mcp" / "sentinel"
            sentinel.parent.mkdir(parents=True)
            sentinel.write_bytes(b"unrelated managed data")

            completed = self._install(archive, lock_path, build_id, home)

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(sentinel.read_bytes(), b"unrelated managed data")
            self.assertTrue(
                (
                    home
                    / ".local"
                    / "share"
                    / "scriptcat-browser"
                    / "current"
                    / "chrome-linux"
                    / "chrome"
                ).is_file()
            )

    def test_install_rejects_build_id_not_derived_from_runtime_inventory(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock_path = root / "provider.lock.json"
            shutil.copyfile(LOCK_SOURCE, lock_path)
            lock = load_lock(lock_path)
            archive = create_provider_archive(
                root,
                lock,
                component_id=COMPONENT_ID,
                build_id=MISMATCHED_BUILD_ID,
            )
            home = root / "home"

            completed = self._install(archive, lock_path, MISMATCHED_BUILD_ID, home)

            self.assertNotEqual(completed.returncode, 0)
            data_root = home / ".local" / "share" / "scriptcat-browser"
            self.assertFalse((data_root / "current").exists())
            self.assertFalse((data_root / "releases").exists())

    def test_second_install_retains_independent_previous_release(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock_path = root / "provider.lock.json"
            shutil.copyfile(LOCK_SOURCE, lock_path)
            lock = load_lock(lock_path)
            first = create_provider_archive(
                root / "first", lock, component_id=COMPONENT_ID, marker="first"
            )
            second = create_provider_archive(
                root / "second", lock, component_id=COMPONENT_ID, marker="second"
            )
            first_build_id = self._archive_build_id(first)
            second_build_id = self._archive_build_id(second)
            home = root / "home"

            self.assertEqual(
                self._install(first, lock_path, first_build_id, home).returncode, 0
            )
            completed = self._install(second, lock_path, second_build_id, home)

            self.assertEqual(completed.returncode, 0, completed.stderr)
            data_root = home / ".local" / "share" / "scriptcat-browser"
            self.assertEqual(
                os.readlink(data_root / "current"),
                str(data_root / "releases" / second_build_id),
            )
            self.assertEqual(
                os.readlink(data_root / "previous"),
                str(data_root / "releases" / first_build_id),
            )

    @staticmethod
    def _archive_build_id(archive: Path) -> str:
        return archive.name.removeprefix("release-").removesuffix(".tar.zst")

    def _install(
        self, archive: Path, lock_path: Path, build_id: str, home: Path
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (
                sys.executable,
                str(INSTALL_SCRIPT),
                str(archive),
                "--lock",
                str(lock_path),
                "--build-id",
                build_id,
                "--archive-sha256",
                archive_sha256(archive),
            ),
            check=False,
            text=True,
            capture_output=True,
            env={**os.environ, "HOME": str(home)},
        )
