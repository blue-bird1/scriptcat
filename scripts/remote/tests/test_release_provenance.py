from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.remote._archive import read_manifest
from scripts.remote._common import WorkflowError
from scripts.remote.tests._fixtures import create_release

UNSUPPORTED_PRODUCT_FIELD = "project_commit"
UNSUPPORTED_PROVENANCE_COMPONENT = "chromium"


class McpReleaseProvenanceTest(unittest.TestCase):
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
