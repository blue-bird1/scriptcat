from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.remote._archive import read_manifest
from scripts.remote._common import RemoteConfig, WorkflowError
from scripts.remote._lock import load_lock
from scripts.remote._remote_build import remote_build_script
from scripts.remote._verified_build import component_build_id, release_build_id
from scripts.remote.tests._fixtures import create_release

UNSUPPORTED_PRODUCT_FIELD = "project_commit"
UNSUPPORTED_PROVENANCE_COMPONENT = "chromium"
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIRST_PARENT_COMMIT = "1" * 40
SECOND_PARENT_COMMIT = "2" * 40
RUNTIME_FILES = {
    "mcp/bin/chrome-devtools-mcp.js": "3" * 64,
    "scriptcat/manifest.json": "4" * 64,
}


class McpReleaseProvenanceTest(unittest.TestCase):
    def test_identical_mcp_lock_reuses_component_and_release_across_parent_commits(
        self,
    ) -> None:
        lock = load_lock(REPOSITORY_ROOT / "browser/mcp.lock.json")
        first_script = remote_build_script(
            RemoteConfig(), lock, FIRST_PARENT_COMMIT, "origin"
        )
        second_script = remote_build_script(
            RemoteConfig(), lock, SECOND_PARENT_COMMIT, "origin"
        )
        first_component = component_build_id(lock.digest)
        second_component = component_build_id(lock.digest)
        first_release = release_build_id(first_component, RUNTIME_FILES)
        second_release = release_build_id(second_component, RUNTIME_FILES)
        self.assertEqual(first_component, second_component)
        self.assertEqual(first_release, second_release)
        self.assertIn(f"build_id={first_component}", first_script)
        self.assertIn(f"build_id={second_component}", second_script)

    def test_release_manifest_rejects_extra_product_identity_field(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            release = create_release(Path(temporary))
            path = release / "manifest.json"
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload[UNSUPPORTED_PRODUCT_FIELD] = "0" * 24
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(WorkflowError):
                read_manifest(release)

    def test_release_manifest_rejects_extra_provenance_component(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            release = create_release(Path(temporary))
            path = release / "manifest.json"
            payload = json.loads(path.read_text(encoding="utf-8"))
            provenance = payload["provenance"]
            if not isinstance(provenance, dict):
                self.fail("fixture provenance must be a mapping")
            provenance[UNSUPPORTED_PROVENANCE_COMPONENT] = {
                "upstream_commit": "0" * 40,
                "build_commit": "1" * 40,
            }
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(WorkflowError):
                read_manifest(release)


if __name__ == "__main__":
    unittest.main()
