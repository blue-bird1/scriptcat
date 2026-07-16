from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.remote._activation import component_build_id, release_build_id
from scripts.remote._lock import load_lock
from scripts.remote.tests._fixtures import (
    create_archive,
    create_release,
    provenance_for_lock,
    sha256,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
INSTALL_SCRIPT = REPOSITORY_ROOT / "scripts" / "remote" / "install.py"
PROJECT_COMMIT = "1" * 40
NEXT_PROJECT_COMMIT = "2" * 40
FORGED_COMMIT = "0" * 40


class OfflineInstallContractTest(unittest.TestCase):
    def test_installs_from_non_git_directory_with_explicit_lock(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock_path = root / "upstreams.lock.json"
            shutil.copyfile(
                REPOSITORY_ROOT / "browser" / "upstreams.lock.json", lock_path
            )
            lock = json.loads(lock_path.read_text(encoding="utf-8"))
            lock_model = load_lock(lock_path)
            lock_digest = hashlib.sha256(lock_path.read_bytes()).hexdigest()
            component_id = component_build_id(lock_digest, PROJECT_COMMIT)
            build_id = release_build_id(component_id, PROJECT_COMMIT)
            release = create_release(root, build_id=build_id)
            self._write_release_provenance(
                release,
                component_build_id=component_id,
                project_commit=PROJECT_COMMIT,
                lock_digest=lock_digest,
                source_provenance=provenance_for_lock(lock_model),
            )
            archive = create_archive(root, release)
            home = root / "home"

            completed = subprocess.run(
                (
                    sys.executable,
                    str(INSTALL_SCRIPT),
                    str(archive),
                    "--lock",
                    str(lock_path),
                    "--build-id",
                    build_id,
                    "--archive-sha256",
                    sha256(archive),
                ),
                check=False,
                cwd=root,
                env={**os.environ, "HOME": str(home)},
                text=True,
                capture_output=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            release_path = (
                home / ".local" / "share" / "scriptcat-mcp" / "releases" / build_id
            )
            self.assertEqual(
                os.readlink(home / ".local" / "share" / "scriptcat-mcp" / "current"),
                str(release_path),
            )
            self.assertTrue(release_path.is_dir())
            extension_path = (
                home
                / ".codex"
                / "chrome-extensions"
                / "scriptcat"
                / f"v{lock['scriptcat']['version']}"
            )
            self._assert_physical_extension_matches(extension_path, release_path)

    def test_new_release_updates_fixed_physical_extension(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock_path = root / "upstreams.lock.json"
            shutil.copyfile(
                REPOSITORY_ROOT / "browser" / "upstreams.lock.json", lock_path
            )
            lock = json.loads(lock_path.read_text(encoding="utf-8"))
            lock_model = load_lock(lock_path)
            lock_digest = hashlib.sha256(lock_path.read_bytes()).hexdigest()
            first_build_id, first_release, first_archive = self._create_release_archive(
                root / "first",
                lock_digest=lock_digest,
                project_commit=PROJECT_COMMIT,
                source_provenance=provenance_for_lock(lock_model),
            )
            home = root / "home"

            first_install = self._install_archive(
                first_archive,
                lock_path=lock_path,
                build_id=first_build_id,
                home=home,
            )

            self.assertEqual(first_install.returncode, 0, first_install.stderr)
            extension_path = self._extension_path(home, lock)
            first_release_path = self._release_path(home, first_build_id)
            self._assert_physical_extension_matches(extension_path, first_release_path)

            second_build_id, second_release, _ = self._create_release_archive(
                root / "second",
                lock_digest=lock_digest,
                project_commit=NEXT_PROJECT_COMMIT,
                source_provenance=provenance_for_lock(lock_model),
            )
            self._replace_release_file(
                second_release,
                "scriptcat/worker.js",
                b"const managed = 'replacement release';\n",
            )
            self._write_release_provenance(
                second_release,
                component_build_id=component_build_id(lock_digest, NEXT_PROJECT_COMMIT),
                project_commit=NEXT_PROJECT_COMMIT,
                lock_digest=lock_digest,
                source_provenance=provenance_for_lock(lock_model),
            )
            second_archive = create_archive(root / "second", second_release)

            second_install = self._install_archive(
                second_archive,
                lock_path=lock_path,
                build_id=second_build_id,
                home=home,
            )

            self.assertEqual(second_install.returncode, 0, second_install.stderr)
            second_release_path = self._release_path(home, second_build_id)
            self._assert_physical_extension_matches(extension_path, second_release_path)
            self.assertEqual(
                os.readlink(home / ".local" / "share" / "scriptcat-mcp" / "current"),
                str(second_release_path),
            )
            self.assertEqual(
                os.readlink(home / ".local" / "share" / "scriptcat-mcp" / "previous"),
                str(first_release_path),
            )

    def test_rejects_rewritten_archive_with_recomputed_internal_checksums(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock_path = root / "upstreams.lock.json"
            shutil.copyfile(
                REPOSITORY_ROOT / "browser" / "upstreams.lock.json", lock_path
            )
            lock_model = load_lock(lock_path)
            lock_digest = hashlib.sha256(lock_path.read_bytes()).hexdigest()
            component_id = component_build_id(lock_digest, PROJECT_COMMIT)
            build_id = release_build_id(component_id, PROJECT_COMMIT)
            release = create_release(root, build_id=build_id)
            self._write_release_provenance(
                release,
                component_build_id=component_id,
                project_commit=PROJECT_COMMIT,
                lock_digest=lock_digest,
                source_provenance=provenance_for_lock(lock_model),
            )
            archive = create_archive(root, release)
            trusted_archive_digest = sha256(archive)
            worker = release / "scriptcat" / "worker.js"
            worker.write_bytes(b"const managed = false;\n")
            manifest_path = release / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["files"]["scriptcat/worker.js"] = sha256(worker)
            manifest_path.write_text(
                json.dumps(manifest, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            self._write_internal_checksums(release, manifest)
            create_archive(root, release)
            home = root / "home"

            completed = subprocess.run(
                (
                    sys.executable,
                    str(INSTALL_SCRIPT),
                    str(archive),
                    "--lock",
                    str(lock_path),
                    "--build-id",
                    build_id,
                    "--archive-sha256",
                    trusted_archive_digest,
                ),
                check=False,
                cwd=root,
                env={**os.environ, "HOME": str(home)},
                text=True,
                capture_output=True,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertFalse((home / ".local" / "share" / "scriptcat-mcp").exists())

    def test_rejects_archive_with_forged_mcp_source_provenance(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock_path = root / "upstreams.lock.json"
            shutil.copyfile(
                REPOSITORY_ROOT / "browser" / "upstreams.lock.json", lock_path
            )
            lock_model = load_lock(lock_path)
            lock_digest = hashlib.sha256(lock_path.read_bytes()).hexdigest()
            component_id = component_build_id(lock_digest, PROJECT_COMMIT)
            build_id = release_build_id(component_id, PROJECT_COMMIT)
            release = create_release(root, build_id=build_id)
            self._write_release_provenance(
                release,
                component_build_id=component_id,
                project_commit=PROJECT_COMMIT,
                lock_digest=lock_digest,
                source_provenance=provenance_for_lock(lock_model),
            )
            manifest_path = release / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            provenance = manifest["provenance"]
            if not isinstance(provenance, dict):
                raise AssertionError("release provenance must be a mapping")
            mcp = provenance["chrome_devtools_mcp"]
            if not isinstance(mcp, dict):
                raise AssertionError("MCP provenance must be a mapping")
            mcp["build_commit"] = FORGED_COMMIT
            manifest_path.write_text(
                json.dumps(manifest, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            self._write_internal_checksums(release, manifest)
            archive = create_archive(root, release)
            home = root / "home"

            completed = self._install_archive(
                archive,
                lock_path=lock_path,
                build_id=build_id,
                home=home,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertFalse((home / ".local" / "share" / "scriptcat-mcp").exists())

    def _write_release_provenance(
        self,
        release: Path,
        *,
        component_build_id: str,
        project_commit: str,
        lock_digest: str,
        source_provenance: dict[str, dict[str, str]] | None = None,
    ) -> None:
        manifest_path = release / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest.update(
            component_build_id=component_build_id,
            project_commit=project_commit,
            lock_digest=lock_digest,
            provenance=source_provenance,
        )
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        self._write_internal_checksums(release, manifest)

    def _create_release_archive(
        self,
        root: Path,
        *,
        lock_digest: str,
        project_commit: str,
        source_provenance: dict[str, dict[str, str]],
    ) -> tuple[str, Path, Path]:
        root.mkdir()
        component_id = component_build_id(lock_digest, project_commit)
        build_id = release_build_id(component_id, project_commit)
        release = create_release(root, build_id=build_id)
        self._write_release_provenance(
            release,
            component_build_id=component_id,
            project_commit=project_commit,
            lock_digest=lock_digest,
            source_provenance=source_provenance,
        )
        return build_id, release, create_archive(root, release)

    def _install_archive(
        self,
        archive: Path,
        *,
        lock_path: Path,
        build_id: str,
        home: Path,
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
                sha256(archive),
            ),
            check=False,
            cwd=archive.parent,
            env={**os.environ, "HOME": str(home)},
            text=True,
            capture_output=True,
        )

    def _replace_release_file(
        self, release: Path, relative: str, contents: bytes
    ) -> None:
        path = release / relative
        path.write_bytes(contents)
        manifest_path = release / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        files = manifest["files"]
        if not isinstance(files, dict):
            raise AssertionError("release manifest files must be a mapping")
        files[relative] = sha256(path)
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    def _extension_path(self, home: Path, lock: dict[str, object]) -> Path:
        scriptcat = lock["scriptcat"]
        if not isinstance(scriptcat, dict):
            raise AssertionError("upstream lock ScriptCat entry must be a mapping")
        version = scriptcat["version"]
        if not isinstance(version, str):
            raise AssertionError("upstream lock ScriptCat version must be a string")
        return home / ".codex" / "chrome-extensions" / "scriptcat" / f"v{version}"

    def _release_path(self, home: Path, build_id: str) -> Path:
        return home / ".local" / "share" / "scriptcat-mcp" / "releases" / build_id

    def _assert_physical_extension_matches(
        self, extension_path: Path, release_path: Path
    ) -> None:
        self.assertTrue(extension_path.is_dir())
        self.assertFalse(extension_path.is_symlink())
        self.assertEqual(
            self._tree_contents(extension_path),
            self._tree_contents(release_path / "scriptcat"),
        )

    def _tree_contents(self, root: Path) -> dict[str, bytes]:
        contents: dict[str, bytes] = {}
        for current, directory_names, file_names in os.walk(root):
            directory_names.sort()
            file_names.sort()
            current_path = Path(current)
            for name in file_names:
                path = current_path / name
                self.assertTrue(path.is_file())
                self.assertFalse(path.is_symlink())
                contents[path.relative_to(root).as_posix()] = path.read_bytes()
        return contents

    def _write_internal_checksums(
        self, release: Path, manifest: dict[str, object]
    ) -> None:
        files = manifest["files"]
        if not isinstance(files, dict):
            raise AssertionError("release manifest files must be a mapping")
        with (release / "SHA256SUMS").open("wb") as stream:
            for relative in sorted([*files, "manifest.json"]):
                stream.write(
                    sha256(release / relative).encode("ascii")
                    + b"  "
                    + relative.encode("utf-8")
                    + b"\0"
                )


if __name__ == "__main__":
    unittest.main()
