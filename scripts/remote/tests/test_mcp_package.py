from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.remote._common import WorkflowError
from scripts.remote.mcp import package

COMPONENT_BUILD_ID = "1" * 24


class McpPackageTransactionTest(unittest.TestCase):
    def test_release_identity_failure_leaves_archive_outputs_unpublished(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            output = root / "mcp.tar.zst"
            digest_output = root / "mcp.tar.zst.sha256"

            def publish_archive(*_args: object) -> str:
                output.write_bytes(b"archive\n")
                digest_output.write_bytes(b"digest\n")
                return "0" * 64

            with (
                patch.object(package, "require_commands"),
                patch.object(package, "require_wg0"),
                patch.object(package, "repository_root", return_value=root),
                patch.object(package, "load_lock", return_value=object()),
                patch.object(package, "portable_package_script", return_value=""),
                patch.object(package, "run_remote_script"),
                patch.object(
                    package,
                    "download_release_id",
                    side_effect=WorkflowError("release identity unavailable"),
                ),
                patch.object(package, "download_archive", side_effect=publish_archive),
                self.assertRaises(WorkflowError),
            ):
                package.run(
                    (
                        "--build-id",
                        COMPONENT_BUILD_ID,
                        "--lock",
                        str(root / "mcp.lock.json"),
                        "--output",
                        str(output),
                        "--sha256-output",
                        str(digest_output),
                    )
                )
            self.assertFalse(output.exists())
            self.assertFalse(digest_output.exists())


if __name__ == "__main__":
    unittest.main()
