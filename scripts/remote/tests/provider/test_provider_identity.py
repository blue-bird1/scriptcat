from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.remote.provider._common import WorkflowError
from scripts.remote.provider._identity import (
    BUILD_SCHEMA,
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
FIRST_DIRECTORIES = ("chrome-linux",)
SECOND_DIRECTORIES = ("chrome-linux", "chrome-linux/empty")
UNSUPPORTED_PARENT_FIELD = "project_commit"
LEGACY_PROJECT_COMMIT = "a" * 40


class ProviderIdentityTest(unittest.TestCase):
    def test_remote_release_build_script_disables_dchecks(self) -> None:
        script = remote_build_script(
            ProviderRemoteConfig(), load_lock(LOCK_PATH), FIRST_PARENT_COMMIT, "origin"
        )

        self.assertIn(
            "gn gen out/Release --args='is_debug=false dcheck_always_on=false ",
            script,
        )

    def test_pre_recipe_component_is_not_reused(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name) / "build-root"
            lock = load_lock(LOCK_PATH)
            old_build_id = hashlib.sha256(
                f"provider-component-v{BUILD_SCHEMA}\0{lock.digest}".encode()
            ).hexdigest()[:24]
            old_component = root / "builds" / old_build_id
            chrome = old_component / "runtime" / "chrome-linux" / "chrome"
            chrome.parent.mkdir(parents=True)
            chrome.write_bytes(b"#!/bin/sh\nexit 0\n")
            chrome.chmod(0o755)
            files = {
                "chrome-linux/chrome": hashlib.sha256(chrome.read_bytes()).hexdigest()
            }
            manifest = {
                "schema": BUILD_SCHEMA,
                "build_id": old_build_id,
                "lock_digest": lock.digest,
                "source_date_epoch": 1,
                "versions": {
                    "chromium": lock.chromium.version,
                    "depot_tools": lock.depot_tools.version,
                },
                "provenance": {
                    "chromium": {
                        "upstream_commit": lock.chromium.commit,
                        "patch_digest": lock.chromium_patch.sha256,
                        "build_commit": "a" * 40,
                    },
                    "depot_tools": {
                        "upstream_commit": lock.depot_tools.commit,
                        "build_commit": lock.depot_tools.commit,
                    },
                },
                "files": files,
                "directories": ["chrome-linux"],
            }
            (old_component / "build-manifest.json").write_text(
                json.dumps(manifest), encoding="utf-8"
            )
            (root / "current").parent.mkdir(parents=True, exist_ok=True)
            (root / "current").symlink_to(old_component / "runtime")
            script = verified_build_reuse_script(lock)
            command = (
                f"set -Eeuo pipefail\nbuild_root={root}\n{script}"
                "\nprintf '%s\\n' \"$reuse_status\""
            )

            completed = subprocess.run(
                ("bash", "-c", command),
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout, "build\n")
            self.assertTrue(old_component.is_dir())
            self.assertFalse(
                (root / "builds" / component_build_id(lock.digest)).exists()
            )

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
            release_build_id(
                component_build_id(lock.digest), FIRST_RUNTIME, FIRST_DIRECTORIES
            ),
            release_build_id(
                component_build_id(lock.digest), SECOND_RUNTIME, FIRST_DIRECTORIES
            ),
        )
        self.assertNotEqual(
            release_build_id(
                component_build_id(lock.digest), FIRST_RUNTIME, FIRST_DIRECTORIES
            ),
            release_build_id(
                component_build_id(lock.digest), FIRST_RUNTIME, SECOND_DIRECTORIES
            ),
        )

    def test_release_manifest_rejects_parent_repository_provenance(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock = load_lock(LOCK_PATH)
            archive = create_provider_archive(
                root, lock, component_id="fedcba987654321001234567"
            )
            release_name = archive.name.removesuffix(".tar.zst")
            manifest_path = root / release_name / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

            self.assertEqual(set(manifest), RELEASE_FIELDS)
            self.assertNotIn(UNSUPPORTED_PARENT_FIELD, manifest)
            manifest[UNSUPPORTED_PARENT_FIELD] = FIRST_PARENT_COMMIT
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            with self.assertRaises(WorkflowError):
                read_manifest(
                    manifest_path.parent, release_name.removeprefix("release-"), lock
                )

    def test_schema_one_component_is_not_reused(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name) / "build-root"
            lock = load_lock(LOCK_PATH)
            legacy, chrome = self._create_schema_one_current(root, lock)
            content = chrome.read_bytes()

            script = verified_build_reuse_script(lock)
            command = (
                f"set -Eeuo pipefail\nbuild_root={root}\n{script}"
                "\nprintf '%s\\n' \"$reuse_status\""
            )
            completed = subprocess.run(
                ("bash", "-c", command),
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout, "build\n")
            self.assertTrue(legacy.is_dir())
            self.assertEqual(chrome.read_bytes(), content)
            self.assertEqual(os.readlink(root / "current"), str(legacy / "runtime"))
            self.assertFalse(
                (root / "builds" / component_build_id(lock.digest)).exists()
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
