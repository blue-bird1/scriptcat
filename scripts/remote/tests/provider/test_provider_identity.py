from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.remote.provider._identity import component_build_id, release_build_id
from scripts.remote.provider._lock import load_lock
from scripts.remote.provider._remote import ProviderRemoteConfig, remote_build_script
from scripts.remote.provider._release import RELEASE_FIELDS, read_manifest
from scripts.remote._common import WorkflowError
from scripts.remote.tests.provider._fixtures import create_provider_archive

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
LOCK_PATH = REPOSITORY_ROOT / "browser" / "provider.lock.json"
FIRST_PARENT_COMMIT = "1" * 40
SECOND_PARENT_COMMIT = "2" * 40
FIRST_RUNTIME = {"chrome-linux/chrome": "3" * 64}
SECOND_RUNTIME = {"chrome-linux/chrome": "4" * 64}
UNSUPPORTED_PARENT_FIELD = "project_commit"


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

        self.assertNotEqual(component_build_id(lock.digest), component_build_id("0" * 64))
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


if __name__ == "__main__":
    unittest.main()
