from __future__ import annotations

import unittest
from pathlib import Path

from scripts.remote._common import RemoteConfig
from scripts.remote._lock import load_lock
from scripts.remote._remote_build import remote_build_script

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

    def test_does_not_inspect_or_execute_a_browser_provider(self) -> None:
        for forbidden in (
            "external_browser",
            "PUPPETEER_EXECUTABLE_PATH",
            "SANDBOX_BROWSER_SOURCE",
            "scriptcat-browser",
            "chrome-linux",
            "provider_release",
            "tests/tools/extensions.test.ts",
            "tests/ManagedBrowserShutdown.test.ts",
        ):
            self.assertNotIn(forbidden, self.script)

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
