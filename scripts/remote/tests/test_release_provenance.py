from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.remote._activation import activate_archive
from scripts.remote._lock import load_lock
from scripts.remote._portable_package import portable_package_script
from scripts.remote.package import ARCHIVE_PREFIX, release_build_id
from scripts.remote.tests._fixtures import (
    CHROMIUM_VERSION,
    DEPOT_TOOLS_VERSION,
    MCP_VERSION,
    SCRIPTCAT_VERSION,
    create_archive,
    create_release,
    release_tree,
    sha256,
)

COMPONENT_BUILD_ID = "0123456789abcdef01234567"
PROJECT_COMMIT = "1" * 40
OTHER_PROJECT_COMMIT = "2" * 40


class ReleaseProvenanceTest(unittest.TestCase):
    def test_package_rejects_component_build_from_another_commit(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            repository = Path(__file__).resolve().parents[3]
            lock = load_lock(repository / "browser/upstreams.lock.json")
            runtime = root / "builds" / COMPONENT_BUILD_ID / "runtime"
            self._write_runtime(runtime)
            self._write_build_manifest(runtime, lock.digest, OTHER_PROJECT_COMMIT)
            script = root / "package.sh"
            script.write_text(
                portable_package_script(
                    f"{ARCHIVE_PREFIX}-{COMPONENT_BUILD_ID}.tar.zst",
                    lock,
                    component_build_id=COMPONENT_BUILD_ID,
                    release_build_id=COMPONENT_BUILD_ID,
                    project_commit=PROJECT_COMMIT,
                    build_root=str(root),
                ),
                encoding="utf-8",
            )

            completed = subprocess.run(
                ("bash", str(script)),
                check=False,
                cwd=root,
                text=True,
                capture_output=True,
            )

            self.assertNotEqual(completed.returncode, 0)
            release = root / "out" / f"release-{COMPONENT_BUILD_ID}"
            self.assertFalse(release.exists())

    def test_activation_accepts_matching_release_provenance(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock_digest = hashlib.sha256(b"current lock").hexdigest()
            component_id = self._component_build_id(lock_digest, PROJECT_COMMIT)
            release_id = release_build_id(component_id, PROJECT_COMMIT)
            release = create_release(root, build_id=release_id)
            self._write_release_provenance(
                release,
                component_build_id=component_id,
                project_commit=PROJECT_COMMIT,
                lock_digest=lock_digest,
            )
            archive = create_archive(root, release)

            activated = activate_archive(
                archive,
                root / "data",
                root / "extensions" / SCRIPTCAT_VERSION,
                release_id,
                CHROMIUM_VERSION,
                MCP_VERSION,
                DEPOT_TOOLS_VERSION,
                SCRIPTCAT_VERSION,
                lock_digest,
                PROJECT_COMMIT,
            )

            self.assertEqual(activated, release_id)

    def test_activation_binds_selected_lock_without_local_project_commit(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock_digest = hashlib.sha256(b"selected lock").hexdigest()
            component_id = self._component_build_id(lock_digest, PROJECT_COMMIT)
            release_id = release_build_id(component_id, PROJECT_COMMIT)
            release = create_release(root, build_id=release_id)
            self._write_release_provenance(
                release,
                component_build_id=component_id,
                project_commit=PROJECT_COMMIT,
                lock_digest=lock_digest,
            )
            archive = create_archive(root, release)

            activated = activate_archive(
                archive,
                root / "data",
                root / "extensions" / SCRIPTCAT_VERSION,
                release_id,
                CHROMIUM_VERSION,
                MCP_VERSION,
                DEPOT_TOOLS_VERSION,
                SCRIPTCAT_VERSION,
                lock_digest,
            )

            self.assertEqual(activated, release_id)

    def test_activation_rejects_provenance_mismatch(self) -> None:
        cases = (
            ("lock_digest", hashlib.sha256(b"other lock").hexdigest()),
            ("project_commit", OTHER_PROJECT_COMMIT),
            ("component_build_id", COMPONENT_BUILD_ID),
        )
        for field, replacement in cases:
            with (
                self.subTest(field=field),
                tempfile.TemporaryDirectory(dir="/tmp") as temporary_name,
            ):
                root = Path(temporary_name)
                lock_digest = hashlib.sha256(b"current lock").hexdigest()
                component_id = self._component_build_id(lock_digest, PROJECT_COMMIT)
                release_id = release_build_id(component_id, PROJECT_COMMIT)
                release = create_release(root, build_id=release_id)
                provenance = {
                    "component_build_id": component_id,
                    "project_commit": PROJECT_COMMIT,
                    "lock_digest": lock_digest,
                }
                provenance[field] = replacement
                self._write_release_provenance(release, **provenance)
                archive = create_archive(root, release)
                data_root = root / "data"

                with self.assertRaisesRegex(RuntimeError, "requested provenance"):
                    activate_archive(
                        archive,
                        data_root,
                        root / "extensions" / SCRIPTCAT_VERSION,
                        release_id,
                        CHROMIUM_VERSION,
                        MCP_VERSION,
                        DEPOT_TOOLS_VERSION,
                        SCRIPTCAT_VERSION,
                        lock_digest,
                        PROJECT_COMMIT,
                    )
                self.assertFalse(data_root.exists())

    def test_activation_rejects_existing_release_with_other_provenance(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock_digest = hashlib.sha256(b"current lock").hexdigest()
            component_id = self._component_build_id(lock_digest, PROJECT_COMMIT)
            release_id = release_build_id(component_id, PROJECT_COMMIT)
            release = create_release(root, build_id=release_id)
            self._write_release_provenance(
                release,
                component_build_id=component_id,
                project_commit=PROJECT_COMMIT,
                lock_digest=lock_digest,
            )
            archive = create_archive(root, release)
            existing = root / "data" / "releases" / release_id
            shutil.copytree(release, existing)
            self._write_release_provenance(
                existing,
                component_build_id=COMPONENT_BUILD_ID,
                project_commit=PROJECT_COMMIT,
                lock_digest=lock_digest,
            )

            with self.assertRaisesRegex(RuntimeError, "conflicts"):
                activate_archive(
                    archive,
                    root / "data",
                    root / "extensions" / SCRIPTCAT_VERSION,
                    release_id,
                    CHROMIUM_VERSION,
                    MCP_VERSION,
                    DEPOT_TOOLS_VERSION,
                    SCRIPTCAT_VERSION,
                    lock_digest,
                    PROJECT_COMMIT,
                )

    def _write_runtime(self, runtime: Path) -> None:
        files = {
            "chromium/chrome-linux/chrome": b"#!/bin/sh\nexit 0\n",
            "mcp/bin/chrome-devtools-mcp.js": b"export const ready = true;\n",
            "scriptcat/manifest.json": b'{"manifest_version":3}\n',
        }
        for relative, payload in files.items():
            path = runtime / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)

    def _write_build_manifest(
        self, runtime: Path, lock_digest: str, project_commit: str
    ) -> None:
        files, directories = release_tree(runtime)
        manifest = {
            "schema": 1,
            "build_id": COMPONENT_BUILD_ID,
            "project_commit": project_commit,
            "lock_digest": lock_digest,
            "source_date_epoch": 1,
            "chromium_version": "chromium",
            "mcp_version": "mcp",
            "depot_tools_version": "depot-tools",
            "scriptcat_version": "scriptcat",
            "files": files,
            "directories": directories,
        }
        (runtime.parent / "build-manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
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

    def _component_build_id(self, lock_digest: str, project_commit: str) -> str:
        source = f"{lock_digest}{project_commit}".encode()
        return hashlib.sha256(source).hexdigest()[:24]


if __name__ == "__main__":
    unittest.main()
