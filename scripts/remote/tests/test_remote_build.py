from __future__ import annotations

import unittest
from pathlib import Path

from scripts.remote._common import RemoteConfig
from scripts.remote._lock import load_lock
from scripts.remote._remote_build import REMOTE_TEST_BROWSER, remote_build_script

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
PROJECT_COMMIT = "0" * 40


class McpRemoteBuildContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.lock = load_lock(REPOSITORY_ROOT / "browser/mcp.lock.json")
        self.script = remote_build_script(
            RemoteConfig(),
            self.lock,
            PROJECT_COMMIT,
            "https://example.invalid/scriptcat.git",
        )

    def test_uses_only_fixed_external_browser_for_focused_tests(self) -> None:
        self.assertIn(f"external_browser={REMOTE_TEST_BROWSER}", self.script)
        self.assertIn('test -x "$external_browser"', self.script)
        self.assertIn('"$external_browser" --version', self.script)
        self.assertIn("PUPPETEER_EXECUTABLE_PATH", self.script)
        self.assertNotIn("test-provider", self.script)
        self.assertNotIn("receipt", self.script)

    def test_builds_only_mcp_and_scriptcat(self) -> None:
        self.assertIn('mkdir -p "$runtime/mcp" "$runtime/scriptcat"', self.script)
        self.assertNotIn('"$runtime/chromium"', self.script)
        for forbidden_command in (
            "gclient sync",
            "gclient runhooks",
            "autoninja",
            "browser_tests",
        ):
            self.assertNotIn(forbidden_command, self.script)

    def test_retains_focused_mcp_and_scriptcat_test_gates(self) -> None:
        self.assertIn("ManagedExtensionConsistency.test.ts", self.script)
        self.assertIn("ProfileLock.test.ts", self.script)
        self.assertIn("managed_mcp.test.ts", self.script)
        self.assertIn("regular_updatecheck.test.ts", self.script)

    def test_sandbox_uses_controlled_files_without_bash_c(self) -> None:
        self.assertIn('command_file="$test_root/command.sh"', self.script)
        self.assertIn('launcher_file="$test_root/launcher.sh"', self.script)
        self.assertNotIn("bash -c", self.script)


if __name__ == "__main__":
    unittest.main()
