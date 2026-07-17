from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from scripts.remote._common import WorkflowError
from scripts.remote.provider._identity import (
    component_build_id,
    legacy_component_build_id,
    release_build_id,
)
from scripts.remote.provider._lock import ProviderLock, load_lock
from scripts.remote.provider._release import RELEASE_FIELDS, read_manifest
from scripts.remote.provider._remote import ProviderRemoteConfig, remote_build_script
from scripts.remote.provider._verified_build import verified_build_reuse_script
from scripts.remote.tests.provider._fixtures import create_provider_archive

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
LOCK_PATH = REPOSITORY_ROOT / "browser" / "provider.lock.json"
FIRST_PARENT_COMMIT = "1" * 40
SECOND_PARENT_COMMIT = "2" * 40
FIRST_RUNTIME = {"chrome-linux/chrome": "3" * 64}
SECOND_RUNTIME = {"chrome-linux/chrome": "4" * 64}
UNSUPPORTED_PARENT_FIELD = "project_commit"
LEGACY_PROJECT_COMMIT = "a" * 40


class ProviderIdentityTest(unittest.TestCase):
    def test_component_reuse_is_independent_of_parent_commit(self) -> None:
        lock = load_lock(LOCK_PATH)

        first_script = remote_build_script(
            ProviderRemoteConfig(), lock, FIRST_PARENT_COMMIT, "origin"
        )
        second_script = remote_build_script(
            ProviderRemoteConfig(), lock, SECOND_PARENT_COMMIT, "origin"
        )
        component_id = component_build_id(lock.digest)

        self.assertIn(f"build_id={component_id}", first_script)
        self.assertIn(f"build_id={component_id}", second_script)
        self.assertIn("reusing verified browser provider component build", first_script)

    def test_provider_input_and_runtime_changes_have_distinct_identities(self) -> None:
        lock = load_lock(LOCK_PATH)

        self.assertNotEqual(
            component_build_id(lock.digest), component_build_id("0" * 64)
        )
        self.assertNotEqual(
            release_build_id(component_build_id(lock.digest), FIRST_RUNTIME),
            release_build_id(component_build_id(lock.digest), SECOND_RUNTIME),
        )

    def test_release_manifest_rejects_parent_repository_provenance(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock = load_lock(LOCK_PATH)
            create_provider_archive(
                root,
                lock,
                build_id="0123456789abcdef01234567",
                component_id="fedcba987654321001234567",
            )
            manifest_path = root / "release-0123456789abcdef01234567" / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

            self.assertEqual(set(manifest), RELEASE_FIELDS)
            self.assertNotIn(UNSUPPORTED_PARENT_FIELD, manifest)
            manifest[UNSUPPORTED_PARENT_FIELD] = FIRST_PARENT_COMMIT
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            with self.assertRaises(WorkflowError):
                read_manifest(
                    manifest_path.parent,
                    "0123456789abcdef01234567",
                    lock,
                )

    def test_current_schema_one_build_rekeys_without_rebuilding_runtime(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name) / "build-root"
            lock = load_lock(LOCK_PATH)
            legacy, chrome = self._create_schema_one_current(root, lock)
            before = chrome.stat()
            content = chrome.read_bytes()

            completed = self._run_reuse_script(root, lock)

            self.assertEqual(completed.returncode, 0, completed.stderr)
            component = root / "builds" / component_build_id(lock.digest)
            self.assertFalse(legacy.exists())
            self.assertTrue(component.is_dir())
            self.assertEqual(os.readlink(root / "current"), str(component / "runtime"))
            migrated_chrome = component / "runtime" / "chrome-linux" / "chrome"
            self.assertEqual(migrated_chrome.stat().st_ino, before.st_ino)
            self.assertEqual(migrated_chrome.stat().st_mtime_ns, before.st_mtime_ns)
            self.assertEqual(migrated_chrome.read_bytes(), content)
            manifest = json.loads(
                (component / "build-manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["schema"], 2)
            self.assertEqual(manifest["build_id"], component.name)
            self.assertNotIn(UNSUPPORTED_PARENT_FIELD, manifest)

    def test_current_schema_one_build_with_different_lock_is_not_migrated(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name) / "build-root"
            lock = load_lock(LOCK_PATH)
            legacy, _ = self._create_schema_one_current(root, lock)
            other_lock = replace(lock, digest="0" * 64)

            completed = self._run_reuse_script(root, other_lock)

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertTrue(legacy.is_dir())
            self.assertEqual(os.readlink(root / "current"), str(legacy / "runtime"))
            self.assertFalse(
                (root / "builds" / component_build_id(other_lock.digest)).exists()
            )

    def _create_schema_one_current(
        self, root: Path, provider_lock: ProviderLock
    ) -> tuple[Path, Path]:
        legacy_id = legacy_component_build_id(
            provider_lock.digest, LEGACY_PROJECT_COMMIT
        )
        legacy = root / "builds" / legacy_id
        chrome = legacy / "runtime" / "chrome-linux" / "chrome"
        chrome.parent.mkdir(parents=True)
        chrome.write_bytes(b"#!/bin/sh\nexit 0\n")
        chrome.chmod(0o755)
        files = {"chrome-linux/chrome": hashlib.sha256(chrome.read_bytes()).hexdigest()}
        manifest = {
            "schema": 1,
            "build_id": legacy_id,
            "project_commit": LEGACY_PROJECT_COMMIT,
            "lock_digest": provider_lock.digest,
            "source_date_epoch": 1,
            "chromium_version": provider_lock.chromium.version,
            "depot_tools_version": provider_lock.depot_tools.version,
            "provenance": {
                "chromium": {
                    "upstream_commit": provider_lock.chromium.commit,
                    "patch_digest": provider_lock.chromium_patch.sha256,
                    "build_commit": LEGACY_PROJECT_COMMIT,
                },
                "depot_tools": {
                    "upstream_commit": provider_lock.depot_tools.commit,
                    "build_commit": provider_lock.depot_tools.commit,
                },
            },
            "files": files,
            "directories": ["chrome-linux"],
        }
        (legacy / "build-manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        (root / "current").symlink_to(legacy / "runtime")
        return legacy, chrome

    def _run_reuse_script(
        self, root: Path, provider_lock: ProviderLock
    ) -> subprocess.CompletedProcess[str]:
        script = verified_build_reuse_script(provider_lock)
        return subprocess.run(
            ("bash", "-c", f"set -Eeuo pipefail\nbuild_root={root}\n{script}"),
            check=False,
            capture_output=True,
            text=True,
        )


if __name__ == "__main__":
    unittest.main()
