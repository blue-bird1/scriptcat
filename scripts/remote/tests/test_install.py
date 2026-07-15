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
from scripts.remote.tests._fixtures import create_archive, create_release, sha256

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
INSTALL_SCRIPT = REPOSITORY_ROOT / "scripts" / "remote" / "install.py"
PROJECT_COMMIT = "1" * 40


class OfflineInstallContractTest(unittest.TestCase):
    def test_installs_from_non_git_directory_with_explicit_lock(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock_path = root / "upstreams.lock.json"
            shutil.copyfile(
                REPOSITORY_ROOT / "browser" / "upstreams.lock.json", lock_path
            )
            lock = json.loads(lock_path.read_text(encoding="utf-8"))
            lock_digest = hashlib.sha256(lock_path.read_bytes()).hexdigest()
            component_id = component_build_id(lock_digest, PROJECT_COMMIT)
            build_id = release_build_id(component_id, PROJECT_COMMIT)
            release = create_release(root, build_id=build_id)
            self._write_release_provenance(
                release,
                component_build_id=component_id,
                project_commit=PROJECT_COMMIT,
                lock_digest=lock_digest,
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
            self.assertTrue(
                (
                    home
                    / ".codex"
                    / "chrome-extensions"
                    / "scriptcat"
                    / f"v{lock['scriptcat']['version']}"
                    / "worker.js"
                ).is_file()
            )

    def _write_release_provenance(
        self,
        release: Path,
        *,
        component_build_id: str,
        project_commit: str,
        lock_digest: str,
    ) -> None:
        manifest_path = release / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest.update(
            component_build_id=component_build_id,
            project_commit=project_commit,
            lock_digest=lock_digest,
        )
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        with (release / "SHA256SUMS").open("wb") as stream:
            for relative in sorted([*manifest["files"], "manifest.json"]):
                stream.write(
                    sha256(release / relative).encode("ascii")
                    + b"  "
                    + relative.encode("utf-8")
                    + b"\0"
                )


if __name__ == "__main__":
    unittest.main()
