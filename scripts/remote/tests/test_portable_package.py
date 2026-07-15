from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.remote._archive import archive_digest_path
from scripts.remote._lock import load_lock
from scripts.remote._portable_package import portable_package_script
from scripts.remote.package import ARCHIVE_PREFIX

COMPONENT_BUILD_ID = "0123456789abcdef01234567"
RELEASE_BUILD_ID = "89abcdef0123456701234567"
PROJECT_COMMIT = "0" * 40


class PortablePackageScriptTest(unittest.TestCase):
    def test_generated_remote_script_contains_no_nul_bytes(self) -> None:
        root = Path(__file__).resolve().parents[3]
        lock = load_lock(root / "browser/upstreams.lock.json")

        script = portable_package_script(
            f"{ARCHIVE_PREFIX}-{lock.digest[:24]}.tar.zst",
            lock,
            component_build_id=lock.digest[:24],
            release_build_id=lock.digest[-24:],
            project_commit=PROJECT_COMMIT,
        )

        self.assertNotIn(chr(0), script)

    def test_retry_reuses_verified_remote_release_and_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            script, archive, release = self._create_verified_package_input(temporary)

            self._run_remote_package(script, temporary)
            archive_digest = self._digest(archive)
            digest_sidecar = archive_digest_path(archive)
            digest_sidecar_payload = digest_sidecar.read_text(encoding="ascii")
            release_manifest = (release / "manifest.json").read_bytes()

            self.assertEqual(digest_sidecar_payload, f"{archive_digest}\n")

            self._run_remote_package(script, temporary)

            self.assertEqual(self._digest(archive), archive_digest)
            self.assertEqual(
                digest_sidecar.read_text(encoding="ascii"), digest_sidecar_payload
            )
            self.assertEqual((release / "manifest.json").read_bytes(), release_manifest)

    def test_retry_rejects_existing_release_with_modified_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            script, archive, release = self._create_verified_package_input(temporary)
            self._run_remote_package(script, temporary)
            archive_digest = self._digest(archive)
            runtime_file = release / "chromium/chrome-linux/chrome"
            runtime_file.write_bytes(b"modified runtime\n")

            completed = self._run_remote_package(script, temporary, check=False)

            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(self._digest(archive), archive_digest)
            self.assertEqual(runtime_file.read_bytes(), b"modified runtime\n")

    def test_retry_rejects_existing_archive_with_modified_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            script, archive, _ = self._create_verified_package_input(temporary)
            self._run_remote_package(script, temporary)
            archive.write_bytes(archive.read_bytes() + b"modified archive\n")
            archive_digest = self._digest(archive)

            completed = self._run_remote_package(script, temporary, check=False)

            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(self._digest(archive), archive_digest)

    def test_retry_rejects_modified_external_archive_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            script, archive, _ = self._create_verified_package_input(temporary)
            self._run_remote_package(script, temporary)
            digest_sidecar = archive_digest_path(archive)
            digest_sidecar.write_text(f"{'0' * 64}\n", encoding="ascii")

            completed = self._run_remote_package(script, temporary, check=False)

            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(
                digest_sidecar.read_text(encoding="ascii"), f"{'0' * 64}\n"
            )

    def _create_verified_package_input(self, root: Path) -> tuple[Path, Path, Path]:
        repository = Path(__file__).resolve().parents[3]
        lock = load_lock(repository / "browser/upstreams.lock.json")
        build_root = root / "remote-build"
        runtime = build_root / "builds" / COMPONENT_BUILD_ID / "runtime"
        runtime_files = {
            "chromium/chrome-linux/chrome": b"#!/bin/sh\nexit 0\n",
            "mcp/bin/chrome-devtools-mcp.js": b"export const ready = true;\n",
            "scriptcat/manifest.json": b'{"manifest_version":3}\n',
        }
        for relative, payload in runtime_files.items():
            path = runtime / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
        manifest = {
            "schema": 1,
            "build_id": COMPONENT_BUILD_ID,
            "project_commit": PROJECT_COMMIT,
            "lock_digest": lock.digest,
            "source_date_epoch": 1,
            "chromium_version": lock.chromium.version,
            "mcp_version": lock.mcp.version,
            "depot_tools_version": lock.depot_tools.version,
            "scriptcat_version": lock.scriptcat.version,
            "files": {
                relative: hashlib.sha256(payload).hexdigest()
                for relative, payload in sorted(runtime_files.items())
            },
            "directories": [
                "chromium",
                "chromium/chrome-linux",
                "mcp",
                "mcp/bin",
                "scriptcat",
            ],
        }
        manifest_path = runtime.parent / "build-manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        archive_name = f"{ARCHIVE_PREFIX}-{RELEASE_BUILD_ID}.tar.zst"
        script = root / "package.sh"
        script.write_text(
            portable_package_script(
                archive_name,
                lock,
                component_build_id=COMPONENT_BUILD_ID,
                release_build_id=RELEASE_BUILD_ID,
                project_commit=PROJECT_COMMIT,
                build_root=str(build_root),
            ),
            encoding="utf-8",
        )
        return (
            script,
            build_root / "out" / archive_name,
            build_root / "out" / f"release-{RELEASE_BUILD_ID}",
        )

    def _run_remote_package(
        self, script: Path, root: Path, *, check: bool = True
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ("bash", str(script)),
            check=check,
            cwd=root,
            text=True,
            capture_output=True,
        )

    def _digest(self, path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    unittest.main()
