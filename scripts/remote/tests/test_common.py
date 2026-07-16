from __future__ import annotations

import json
import tomllib
import unittest
from pathlib import Path

from scripts.remote._common import extension_root

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
MCP_SERVER = "chrome-devtools-scriptcat"
MANAGED_PATH_ARGUMENT = "--managed-scriptcat-path="


class ExtensionRootContractTest(unittest.TestCase):
    def test_extension_root_matches_managed_scriptcat_path(self) -> None:
        config_path = REPOSITORY_ROOT / ".codex" / "config.toml"
        lock_path = REPOSITORY_ROOT / "browser" / "mcp.lock.json"
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        arguments = config["mcp_servers"][MCP_SERVER]["args"]
        managed_path = next(
            argument.removeprefix(MANAGED_PATH_ARGUMENT)
            for argument in arguments
            if argument.startswith(MANAGED_PATH_ARGUMENT)
        )
        scriptcat_version = lock["scriptcat"]["version"]

        self.assertEqual(extension_root(scriptcat_version), Path(managed_path))
        self.assertEqual(Path(managed_path).name.removeprefix("v"), scriptcat_version)


if __name__ == "__main__":
    unittest.main()
