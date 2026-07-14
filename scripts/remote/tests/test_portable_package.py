from __future__ import annotations

import unittest
from pathlib import Path

from scripts.remote._lock import load_lock
from scripts.remote._portable_package import portable_package_script
from scripts.remote.build_install import ARCHIVE_NAME


class PortablePackageScriptTest(unittest.TestCase):
    def test_generated_remote_script_contains_no_nul_bytes(self) -> None:
        root = Path(__file__).resolve().parents[3]
        lock = load_lock(root / "browser/upstreams.lock.json")

        script = portable_package_script(ARCHIVE_NAME, lock)

        self.assertNotIn(chr(0), script)


if __name__ == "__main__":
    unittest.main()
