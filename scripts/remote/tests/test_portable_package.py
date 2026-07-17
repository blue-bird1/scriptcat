from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.remote._archive import single_release_root, unpack_archive
from scripts.remote._lock import load_lock
from scripts.remote._portable_package import portable_package_script
from scripts.remote._verified_build import BUILD_SCHEMA, release_build_id
from scripts.remote.mcp.package import ARCHIVE_PREFIX
from scripts.remote.tests._fixtures import provenance_for_lock

COMPONENT_BUILD_ID = "0123456789abcdef01234567"


class PortablePackageScriptTest(unittest.TestCase):
    def test_package_contains_only_mcp_and_scriptcat_runtime_roots(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            script, archive, _ = self._create_verified_package_input(root)
            self._run_package(script, root)
            staging = root / "unpacked"
            staging.mkdir()
            unpack_archive(archive, staging)
            release = single_release_root(staging)
            self.assertEqual(
                {entry.name for entry in release.iterdir()},
                {"mcp", "scriptcat", "manifest.json", "SHA256SUMS"},
            )
            manifest = json.loads(
                (release / "manifest.json").read_text(encoding="utf-8")
            )
            serialized = json.dumps(manifest, sort_keys=True)
            for forbidden in ("chromium", "depot_tools", "gclient", "provider"):
                self.assertNotIn(forbidden, serialized)

    def test_package_succeeds_without_external_browser_root(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            self.assertFalse((root / "scriptcat-browser-build").exists())
            script, archive, _ = self._create_verified_package_input(root)
            self._run_package(script, root)
            self.assertTrue(archive.is_file())

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

    def _create_verified_package_input(self, root: Path) -> tuple[Path, Path, Path]:
        repository = Path(__file__).resolve().parents[3]
        lock = load_lock(repository / "browser/mcp.lock.json")
        build_root = root / "remote-build"
        runtime = build_root / "builds" / COMPONENT_BUILD_ID / "runtime"
        runtime_files = {
            "mcp/bin/chrome-devtools-mcp.js": b"export const ready = true;\n",
            "scriptcat/manifest.json": b'{"manifest_version":3}\n',
        }
        for relative, payload in runtime_files.items():
            path = runtime / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
        manifest = {
            "schema": BUILD_SCHEMA,
            "build_id": COMPONENT_BUILD_ID,
            "lock_digest": lock.digest,
            "source_date_epoch": 1,
            "versions": {
                "chrome_devtools_mcp": lock.mcp.version,
                "scriptcat": lock.scriptcat.version,
            },
            "provenance": provenance_for_lock(lock),
            "files": {
                relative: hashlib.sha256(payload).hexdigest()
                for relative, payload in sorted(runtime_files.items())
            },
            "directories": ["mcp", "mcp/bin", "scriptcat"],
        }
        (runtime.parent / "build-manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        runtime_digests = manifest["files"]
        if not isinstance(runtime_digests, dict):
            self.fail("fixture runtime files must be a mapping")
        release_id = release_build_id(COMPONENT_BUILD_ID, runtime_digests)
        archive_name = f"{ARCHIVE_PREFIX}-{COMPONENT_BUILD_ID}.tar.zst"
        script = root / "package.sh"
        script.write_text(
            portable_package_script(
                archive_name,
                lock,
                component_build_id=COMPONENT_BUILD_ID,
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
