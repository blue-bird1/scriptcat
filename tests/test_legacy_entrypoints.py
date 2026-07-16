from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

from scripts.remote.build import LEGACY_TARGETS


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINTS = tuple(
    REPOSITORY_ROOT / "scripts" / "remote" / name
    for name in ("build.py", "package.py", "install.py", "build_install.py")
)


class LegacyEntrypointCliTest(unittest.TestCase):
    def test_help_describes_explicit_migration_targets(self) -> None:
        for entrypoint in ENTRYPOINTS:
            with self.subTest(entrypoint=entrypoint.name):
                result = subprocess.run(
                    (sys.executable, str(entrypoint), "--help"),
                    cwd=REPOSITORY_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )

                self.assertEqual(result.returncode, 0)
                for target in LEGACY_TARGETS:
                    self.assertIn(target, result.stdout)

    def test_invocation_fails_without_running_a_stage(self) -> None:
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
                for target in LEGACY_TARGETS:
                    self.assertIn(target, result.stderr)
                self.assertIn("no stage was run", result.stderr)


if __name__ == "__main__":
    unittest.main()
