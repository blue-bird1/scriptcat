from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

from scripts.remote.provider._lock import load_lock
from scripts.remote.provider._patching import chromium_patch_preparation_script

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
LOCK_PATH = REPOSITORY_ROOT / "browser" / "provider.lock.json"


class ProviderRemoteBuildWorkflowTest(unittest.TestCase):
    def test_patch_command_expands_the_remote_checkout_path(self) -> None:
        checkout = "/tmp/remote provider checkout"
        lock = load_lock(LOCK_PATH)
        _, patch_command = chromium_patch_preparation_script(lock)
        harness = "\n".join(
            (
                "set -Eeuo pipefail",
                "build_root=/tmp/remote-provider-build",
                f"checkout={checkout!r}",
                "activate_chromium_patch() { printf '%s\\n' \"$4\"; }",
                patch_command,
            )
        )

        completed = subprocess.run(
            ("bash", "-c", harness),
            check=False,
            text=True,
            capture_output=True,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(
            completed.stdout,
            f"{checkout}/{lock.chromium_patch.path.as_posix()}\n",
        )


if __name__ == "__main__":
    unittest.main()
