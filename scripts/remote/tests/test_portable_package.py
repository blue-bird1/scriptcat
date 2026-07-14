from __future__ import annotations

import unittest
from pathlib import Path

from scripts.remote._lock import load_lock
from scripts.remote._portable_package import portable_package_script
from scripts.remote.package import ARCHIVE_PREFIX


class PortablePackageScriptTest(unittest.TestCase):
    def test_generated_remote_script_contains_no_nul_bytes(self) -> None:
        root = Path(__file__).resolve().parents[3]
        lock = load_lock(root / "browser/upstreams.lock.json")

        script = portable_package_script(
            f"{ARCHIVE_PREFIX}-{lock.digest[:24]}.tar.zst",
            lock,
            component_build_id=lock.digest[:24],
            release_build_id=lock.digest[-24:],
        )

        self.assertNotIn(chr(0), script)


if __name__ == "__main__":
    unittest.main()
