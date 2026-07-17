from __future__ import annotations

import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.remote._lock import load_lock
from scripts.remote._portable_package import portable_package_script
from scripts.remote._verified_build import release_build_id
from scripts.remote.mcp.package import ARCHIVE_PREFIX
from scripts.remote.tests._fixtures import create_verified_component_build


class PortablePackageScriptTest(unittest.TestCase):
    def test_empty_runtime_directory_changes_release_identity(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            first_script, first_archive, first_release = (
                self._create_verified_package_input(root / "first")
            )
            second_script, second_archive, second_release = (
                self._create_verified_package_input(
                    root / "second", extra_directories=("mcp/empty",)
                )
            )

            self._run_package(first_script, root)
            self._run_package(second_script, root)

            self.assertTrue(first_archive.is_file())
            self.assertTrue(second_archive.is_file())
            self.assertTrue(first_release.is_dir())
            self.assertTrue(second_release.is_dir())
            self.assertNotEqual(first_release.name, second_release.name)

    def test_retry_rejects_modified_release_runtime(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            script, archive, release = self._create_verified_package_input(root)
            self._run_package(script, root)
            archive_digest = self._digest(archive)
            (release / "mcp/bin/chrome-devtools-mcp.js").write_bytes(b"modified\n")
            completed = self._run_package(script, root, check=False)
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(self._digest(archive), archive_digest)

    def test_retry_rejects_modified_release_checksums(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            script, archive, release = self._create_verified_package_input(root)
            self._run_package(script, root)
            archive_digest = self._digest(archive)
            (release / "SHA256SUMS").write_bytes(b"modified\0")
            completed = self._run_package(script, root, check=False)
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(self._digest(archive), archive_digest)

    def test_package_replaces_stale_target_release_staging(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            script, archive, release = self._create_verified_package_input(root)
            stale = release.parent / f".{release.name}-new"
            stale.mkdir(parents=True)
            (stale / "partial").write_bytes(b"interrupted package\n")
            self._run_package(script, root)
            self.assertTrue(archive.is_file())
            self.assertFalse(stale.exists())

    def _create_verified_package_input(
        self, root: Path, *, extra_directories: tuple[str, ...] = ()
    ) -> tuple[Path, Path, Path]:
        repository = Path(__file__).resolve().parents[3]
        lock = load_lock(repository / "browser/mcp.lock.json")
        (
            build_root,
            component_id,
            runtime_digests,
            runtime_directories,
        ) = create_verified_component_build(
            root, lock, extra_directories=extra_directories
        )
        release_id = release_build_id(
            component_id, runtime_digests, runtime_directories
        )
        archive_name = f"{ARCHIVE_PREFIX}-{component_id}.tar.zst"
        script = root / "package.sh"
        script.write_text(
            portable_package_script(
                archive_name,
                lock,
                component_build_id=component_id,
                build_root=str(build_root),
            ),
            encoding="utf-8",
        )
        return (
            script,
            build_root / "out" / archive_name,
            build_root / "out" / f"release-{release_id}",
        )

    @staticmethod
    def _run_package(
        script: Path, root: Path, *, check: bool = True
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ("bash", str(script)),
            check=check,
            cwd=root,
            text=True,
            capture_output=True,
        )

    @staticmethod
    def _digest(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    unittest.main()
