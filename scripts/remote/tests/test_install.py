from __future__ import annotations

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
INSTALL_SCRIPT = REPOSITORY_ROOT / "scripts" / "remote" / "mcp" / "install.py"
PROJECT_COMMIT = "1" * 40


class OfflineInstallContractTest(unittest.TestCase):
    def test_installs_offline_without_git_or_browser_provider_root(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock_path = root / "mcp.lock.json"
            shutil.copyfile(REPOSITORY_ROOT / "browser" / "mcp.lock.json", lock_path)
            lock = load_lock(lock_path)
            component_id = component_build_id(lock.digest, PROJECT_COMMIT)
            build_id = release_build_id(component_id, PROJECT_COMMIT)
            release = create_release(
                root,
                build_id=build_id,
                component_build_id=component_id,
                project_commit=PROJECT_COMMIT,
                lock_digest=lock.digest,
                provenance=provenance_for_lock(lock),
            )
            archive = create_archive(root, release)
            home = root / "home"
            self.assertFalse((home / ".local/share/scriptcat-browser").exists())
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
            data_root = home / ".local/share/scriptcat-mcp"
            release_path = data_root / "releases" / build_id
            self.assertEqual(os.readlink(data_root / "current"), str(release_path))
            self.assertTrue((release_path / "mcp").is_dir())
            self.assertTrue((release_path / "scriptcat").is_dir())
            self.assertFalse((home / ".local/share/scriptcat-browser").exists())


if __name__ == "__main__":
    unittest.main()
