from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINTS = tuple(
    REPOSITORY_ROOT / "scripts" / "remote" / name
    for name in ("build.py", "package.py", "install.py", "build_install.py")
)


class LegacyEntrypointCliTest(unittest.TestCase):
    def test_invocation_fails(self) -> None:
        for entrypoint in ENTRYPOINTS:
            with self.subTest(entrypoint=entrypoint.name):
                result = subprocess.run(
                    (sys.executable, str(entrypoint)),
                    cwd=REPOSITORY_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )

                self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
