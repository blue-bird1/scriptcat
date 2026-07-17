from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.remote._archive import (
    archive_digest_path,
    read_archive_digest,
    read_manifest,
    sha256,
)
from scripts.remote._lock import load_lock
from scripts.remote._portable_package import portable_package_script
from scripts.remote._verified_build import component_build_id, release_build_id
from scripts.remote.mcp.package import ARCHIVE_PREFIX
from scripts.remote.tests._fixtures import (
    create_archive,
    create_release,
    create_verified_component_build,
    provenance_for_lock,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
INSTALL_SCRIPT = REPOSITORY_ROOT / "scripts" / "remote" / "mcp" / "install.py"
MISMATCHED_BUILD_ID = "f" * 24


class OfflineInstallContractTest(unittest.TestCase):
    def test_package_output_installs_offline_without_other_product_writes(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock_path = REPOSITORY_ROOT / "browser" / "mcp.lock.json"
            lock = load_lock(lock_path)
            (
                build_root,
                component_id,
                runtime_files,
                runtime_directories,
            ) = create_verified_component_build(root, lock)
            expected_release_id = release_build_id(
                component_id, runtime_files, runtime_directories
            )
            archive_name = f"{ARCHIVE_PREFIX}-{component_id}.tar.zst"
            package_script = root / "package.sh"
            package_script.write_text(
                portable_package_script(
                    archive_name,
                    lock,
                    component_build_id=component_id,
                    build_root=str(build_root),
                ),
                encoding="utf-8",
            )
            subprocess.run(
                ("bash", str(package_script)),
                check=True,
                cwd=root,
                text=True,
                capture_output=True,
            )
            archive = build_root / "out" / archive_name
            archive_digest = read_archive_digest(archive_digest_path(archive))
            packaged_release_id = (
                (build_root / "out" / f"release-{component_id}.id")
                .read_text(encoding="ascii")
                .strip()
            )
            self.assertEqual(packaged_release_id, expected_release_id)
            self.assertEqual(archive_digest, sha256(archive))

            home = root / "home"
            managed_root = home / ".codex" / "chrome-extensions" / "scriptcat"
            managed_root.mkdir(parents=True)
            sentinel = managed_root / "sentinel"
            sentinel_payload = b"managed extension remains external\n"
            sentinel.write_bytes(sentinel_payload)
            self.assertFalse((home / ".local/share/scriptcat-browser").exists())
            completed = self._run_install(
                archive,
                lock_path,
                expected_release_id,
                archive_digest,
                home,
                root,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)

            data_root = home / ".local/share/scriptcat-mcp"
            release_path = data_root / "releases" / expected_release_id
            self.assertEqual(os.readlink(data_root / "current"), str(release_path))
            installed_manifest = read_manifest(release_path)
            self.assertEqual(installed_manifest.build_id, expected_release_id)
            self.assertEqual(installed_manifest.files, runtime_files)
            self.assertEqual(
                {entry.name for entry in release_path.iterdir()},
                {"mcp", "manifest.json", "SHA256SUMS"},
            )
            self.assertEqual(sentinel.read_bytes(), sentinel_payload)
            self.assertFalse((home / ".local/share/scriptcat-browser").exists())

    def test_install_rejects_build_id_not_derived_from_runtime_inventory(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock_path = REPOSITORY_ROOT / "browser" / "mcp.lock.json"
            lock = load_lock(lock_path)
            component_id = component_build_id(lock.digest)
            release = create_release(
                root,
                build_id=MISMATCHED_BUILD_ID,
                component_build_id=component_id,
                lock_digest=lock.digest,
                provenance=provenance_for_lock(lock),
            )
            archive = create_archive(root, release)
            home = root / "home"
            completed = self._run_install(
                archive,
                lock_path,
                MISMATCHED_BUILD_ID,
                sha256(archive),
                home,
                root,
            )
            self.assertNotEqual(completed.returncode, 0)
            data_root = home / ".local/share/scriptcat-mcp"
            self.assertFalse((data_root / "current").exists())
            self.assertFalse((data_root / "releases").exists())

    @staticmethod
    def _run_install(
        archive: Path,
        lock_path: Path,
        build_id: str,
        archive_digest: str,
        home: Path,
        working_directory: Path,
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
                archive_digest,
            ),
            check=False,
            cwd=working_directory,
            env={**os.environ, "HOME": str(home)},
            text=True,
            capture_output=True,
        )


if __name__ == "__main__":
    unittest.main()
