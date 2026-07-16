from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.remote._archive import read_manifest
from scripts.remote._common import WorkflowError
from scripts.remote._lock import load_lock
from scripts.remote._verified_build import verified_build_finalize_script
from scripts.remote.tests._fixtures import create_release

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FORBIDDEN_IDENTITIES = ("chromium", "depot_tools", "gclient", "provider")


class McpReleaseProvenanceTest(unittest.TestCase):
    def test_lock_and_release_manifest_contain_only_mcp_sources(self) -> None:
        lock_payload = json.loads(
            (REPOSITORY_ROOT / "browser/mcp.lock.json").read_text(encoding="utf-8")
        )
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            release = create_release(Path(temporary))
            manifest_payload = json.loads(
                (release / "manifest.json").read_text(encoding="utf-8")
            )
        for payload in (lock_payload, manifest_payload):
            serialized = json.dumps(payload, sort_keys=True)
            for forbidden in FORBIDDEN_IDENTITIES:
                self.assertNotIn(forbidden, serialized)

    def test_release_manifest_rejects_extra_browser_identity_field(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            release = create_release(Path(temporary))
            path = release / "manifest.json"
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["browser_build_id"] = "0" * 24
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(WorkflowError):
                read_manifest(release)

    def test_verified_build_manifest_has_only_two_component_provenances(self) -> None:
        lock = load_lock(REPOSITORY_ROOT / "browser/mcp.lock.json")
        script = verified_build_finalize_script(lock, "0" * 40)
        self.assertIn("'chrome_devtools_mcp'", script)
        self.assertIn("'scriptcat'", script)
        for forbidden in FORBIDDEN_IDENTITIES:
            self.assertNotIn(f"'{forbidden}'", script)


if __name__ == "__main__":
    unittest.main()
